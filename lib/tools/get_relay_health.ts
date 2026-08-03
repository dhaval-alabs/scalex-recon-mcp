import { readRelayLogByDateRange, readBatchLogByDateRange } from "../sheets-client";
import { isA5Pending, isTrueSkip, isFailed, classifyBatchRun } from "../status-classify";

export async function getRelayHealth(params: { days?: number }) {
  const days = params.days ?? 14;
  const endDate = new Date().toISOString().substring(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);

  const [rows, batchRows] = await Promise.all([
    readRelayLogByDateRange(startDate, endDate),
    readBatchLogByDateRange(startDate, endDate),
  ]);

  if (rows.length === 0) {
    return { error: "No relay log rows found for period", startDate, endDate };
  }

  // Status breakdown
  const statusCounts = new Map<string, number>();
  for (const r of rows) {
    const s = r.status || "UNKNOWN";
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }

  // GCLID source breakdown — actual values: 'gclid+ec', 'ec_only', 'none'
  const gclidSourceCounts = new Map<string, number>();
  for (const r of rows) {
    const s = r.gclidSource || "none";
    gclidSourceCounts.set(s, (gclidSourceCounts.get(s) ?? 0) + 1);
  }

  const total = rows.length;
  const success = statusCounts.get("SUCCESS") ?? 0;
  const ecOnly = statusCounts.get("SUCCESS_EC_ONLY") ?? 0;
  const failed = Array.from(statusCounts.entries())
    .filter(([k]) => isFailed(k))
    .reduce((s, [, v]) => s + v, 0);
  const skipped = Array.from(statusCounts.entries())
    .filter(([k]) => isTrueSkip(k))
    .reduce((s, [, v]) => s + v, 0);
  // Leads correctly waiting for their day-5 push — not a failure, not a skip.
  // Before this fix these rows counted in `total` but matched none of the
  // buckets above, so percentages silently failed to sum to 100%.
  const a5Pending = Array.from(statusCounts.entries())
    .filter(([k]) => isA5Pending(k))
    .reduce((s, [, v]) => s + v, 0);

  // gclid+ec = has GCLID (from LSQ or cookie), ec_only = no GCLID
  const gclidAttached = gclidSourceCounts.get("gclid+ec") ?? 0;
  const gclidNone = (gclidSourceCounts.get("ec_only") ?? 0) + (gclidSourceCounts.get("none") ?? 0);

  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  // ── Day-5 leg (BatchLog) ───────────────────────────────────────────────
  // The Log tab only ever records FORWARD UPGRADES (a stage change on a lead
  // already pushed). Every lead's FIRST push happens in runDay5Push(), which
  // writes to BatchLog + Firestore only. Without this join the tool reports
  // roughly half of real delivery.
  const day5Runs = batchRows.filter(
    (b) => classifyBatchRun(b.status, b.message) === "day5_push"
  );
  const excludedRuns = batchRows.filter(
    (b) => classifyBatchRun(b.status, b.message) !== "day5_push"
  );
  const day5Pushed = day5Runs.reduce((s, b) => s + (b.processed || 0), 0);
  const day5Failed = day5Runs.reduce((s, b) => s + (b.failed || 0), 0);
  const day5Dropped = day5Runs.reduce((s, b) => s + (b.dropped || 0), 0);

  const forwardPushed = success + ecOnly;
  const totalDelivered = forwardPushed + day5Pushed;
  const totalFailures = failed + day5Failed;

  // Error rate must be measured against ACTUAL PUSH ATTEMPTS, not against all
  // relay log rows — roughly two thirds of Log rows are SKIP_NON_PPC leads
  // that were never upload candidates, which diluted the old rate to
  // meaninglessness.
  const pushAttempts = totalDelivered + totalFailures;
  const deliveryErrorRate = pushAttempts > 0 ? totalFailures / pushAttempts : 0;

  return {
    period: `Last ${days} days (${startDate} to ${endDate})`,
    total_rows: total,
    status_breakdown: {
      SUCCESS: { count: success, pct: pct(success) },
      SUCCESS_EC_ONLY: { count: ecOnly, pct: pct(ecOnly) },
      FAILED: { count: failed, pct: pct(failed) },
      SKIPPED: { count: skipped, pct: pct(skipped) },
      A5_PENDING: {
        count: a5Pending,
        pct: pct(a5Pending),
        note: "Leads correctly waiting for day-5 push — not a failure or skip.",
      },
    },
    gclid_source_breakdown: Object.fromEntries(
      Array.from(gclidSourceCounts.entries()).map(([k, v]) => [
        k, { count: v, pct: pct(v) }
      ])
    ),
    delivery: {
      note:
        "Conversions actually sent to Google Ads. The Log tab records only FORWARD UPGRADES; " +
        "every lead's FIRST push happens in runDay5Push(), which writes to BatchLog/Firestore only. " +
        "Both legs are required for a true delivery figure.",
      forward_upgrades_log_tab: {
        total: forwardPushed,
        with_gclid: success,
        ec_only: ecOnly,
        failed,
      },
      day5_initial_pushes_batchlog: {
        total: day5Pushed,
        failed: day5Failed,
        dropped_or_expired: day5Dropped,
        runs: day5Runs.length,
      },
      total_delivered: totalDelivered,
      log_tab_visible_pct:
        totalDelivered > 0
          ? `${((forwardPushed / totalDelivered) * 100).toFixed(1)}%`
          : "n/a",
      batchlog_rows_excluded: {
        count: excludedRuns.length,
        by_kind: excludedRuns.reduce<Record<string, number>>((acc, b) => {
          const k = classifyBatchRun(b.status, b.message);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        note:
          "Non-day-5 BatchLog rows (retired legacy adjustment runs, pre-flip DISABLED rows, or " +
          "unrecognised message formats). Surfaced deliberately: a non-zero 'unknown' count means " +
          "the day-5 classifier may be missing rows and delivery totals would understate.",
      },
      limitation:
        "BatchLog is aggregate (counts per run, no prospect IDs), so delivery TOTALS are correct " +
        "but per-prospect tracing still requires Firestore, which this MCP cannot reach.",
    },
    rates: {
      // Attach rate is computed over Log-tab rows only — forward upgrades,
      // which are late-funnel and structurally GCLID-poor. It is a BIASED
      // sample of all pushes and understates the true rate. Do not quote it
      // as the account-wide attach rate until the day-5 leg carries per-row
      // gclid data (needs Firestore).
      gclid_attach_rate_log_rows_only: pct(gclidAttached),
      ec_only_rate_log_rows_only: pct(gclidNone),
      delivery_error_rate: `${(deliveryErrorRate * 100).toFixed(2)}%`,
      skip_rate: pct(skipped),
      error_rate_legacy_denominator: pct(failed),
    },
    health: deliveryErrorRate < 0.05 ? "✅ HEALTHY" : "⚠️ NEEDS_REVIEW",
    health_basis:
      "Based on delivery_error_rate (failures / actual push attempts across both legs). The " +
      "previous verdict divided failures by ALL relay log rows — including ~two thirds " +
      "SKIP_NON_PPC leads that were never upload candidates — and could not see day-5 failures at all.",
  };
}
