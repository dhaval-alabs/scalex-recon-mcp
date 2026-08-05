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
  const kindOf = (b: { status: string; message: string; processed: number; dropped: number; failed: number }) =>
    classifyBatchRun(b.status, b.message, (b.processed || 0) + (b.dropped || 0) + (b.failed || 0));

  const day5Runs = batchRows.filter((b) => kindOf(b) === "day5_push");
  const excludedRuns = batchRows.filter((b) => kindOf(b) !== "day5_push");
  const day5Pushed = day5Runs.reduce((s, b) => s + (b.processed || 0), 0);
  const day5Failed = day5Runs.reduce((s, b) => s + (b.failed || 0), 0);
  const day5Dropped = day5Runs.reduce((s, b) => s + (b.dropped || 0), 0);

  // Drops are NOT a homogeneous metric. They mix genuine expiry (past Google's
  // import cutoff — real signal loss) with one-off housekeeping, and BatchLog
  // cannot distinguish them. The A5 go-live backlog clear on 2026-07-20 alone
  // dropped 2760 legacy-schema ledger docs in a single run, which swamps a
  // 14-day total and reads as though thousands of leads are being lost.
  // Surface the largest single run so an outlier is self-evident rather than
  // buried in an aggregate.
  const day5DropMaxRun = day5Runs.reduce((mx, b) => Math.max(mx, b.dropped || 0), 0);
  const day5DroppedExOutlier = day5Dropped - day5DropMaxRun;

  const forwardPushed = success + ecOnly;
  const totalDelivered = forwardPushed + day5Pushed;
  const totalFailures = failed + day5Failed;

  // Error rate must be measured against ACTUAL PUSH ATTEMPTS, not against all
  // relay log rows — roughly two thirds of Log rows are SKIP_NON_PPC leads
  // that were never upload candidates, which diluted the old rate to
  // meaninglessness.
  const pushAttempts = totalDelivered + totalFailures;
  const deliveryErrorRate = pushAttempts > 0 ? totalFailures / pushAttempts : 0;

  // ── DROPS MUST MOVE THE VERDICT ──────────────────────────────────────────
  // A lead dropped past Google's import cutoff is PERMANENT signal loss —
  // strictly worse than a failure, which gets retried on the next sweep. Yet
  // drops appeared nowhere in the health calculation.
  //
  // This gates the cutoff tightening (GCLID_IMPORT_CUTOFF_DAYS 90→75,
  // EC_ONLY 63→58): that change RAISES expiry drops by design, so without
  // this the verdict would stay green while real loss climbed.
  //
  // Uses dropped-excluding-largest-run, so a one-off backlog clear (the 7/20
  // A5 go-live dropped 2760 legacy ledger docs in a single run) cannot trip
  // the alarm, while genuine day-to-day expiry does.
  const lossDenominator = totalDelivered + totalFailures + day5DroppedExOutlier;
  const dropLossRate = lossDenominator > 0 ? day5DroppedExOutlier / lossDenominator : 0;
  // Deliberately tighter than the error threshold: a drop is unrecoverable
  // where a failure is not.
  const DROP_LOSS_THRESHOLD = 0.02;

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
        runs: day5Runs.length,
        dropped_or_expired_total: day5Dropped,
        dropped_largest_single_run: day5DropMaxRun,
        dropped_excluding_largest_run: day5DroppedExOutlier,
        dropped_note:
          "Drops mix genuine expiry (past Google's import cutoff — real signal loss) with one-off " +
          "housekeeping; BatchLog cannot distinguish them. If dropped_largest_single_run dominates " +
          "the total it is almost certainly a backlog clear, not ongoing loss — read " +
          "dropped_excluding_largest_run for the steady-state figure.",
      },
      total_delivered: totalDelivered,
      log_tab_visible_pct:
        totalDelivered > 0
          ? `${((forwardPushed / totalDelivered) * 100).toFixed(1)}%`
          : "n/a",
      batchlog_rows_excluded: {
        count: excludedRuns.length,
        by_kind: excludedRuns.reduce<Record<string, number>>((acc, b) => {
          const k = kindOf(b);
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        note:
          "Non-day-5 BatchLog rows: retired legacy adjustment runs, pre-flip DISABLED rows, " +
          "no_op (idle runs with zero activity — harmless, cannot affect totals), and unknown. " +
          "Only a non-zero 'unknown' count matters: it means a row carrying real counts was not " +
          "recognised, so delivery totals would understate.",
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
    loss: {
      note:
        "Permanent signal loss — leads that expired past Google's import cutoff and can never be " +
        "uploaded. Tracked separately from failures because a failure is retried on the next day-5 " +
        "sweep and a drop is not.",
      permanent_drops: day5DroppedExOutlier,
      drop_loss_rate: `${(dropLossRate * 100).toFixed(2)}%`,
      threshold: `${(DROP_LOSS_THRESHOLD * 100).toFixed(0)}%`,
      excluded_outlier_run: day5DropMaxRun,
      gates:
        "Tightening GCLID_IMPORT_CUTOFF_DAYS (90→75) and EC_ONLY_IMPORT_CUTOFF_DAYS (63→58) will " +
        "increase this by design. Watch this figure across that change, not just the error rate.",
    },
    health:
      deliveryErrorRate < 0.05 && dropLossRate < DROP_LOSS_THRESHOLD
        ? "✅ HEALTHY"
        : "⚠️ NEEDS_REVIEW",
    health_basis:
      "Based on delivery_error_rate (<5%) AND drop_loss_rate (<2%). Drops previously appeared " +
      "nowhere in the verdict, so permanent expiry loss could rise without the status changing. " +
      "Failures are divided by actual push attempts across both legs. The " +
      "previous verdict divided failures by ALL relay log rows — including ~two thirds " +
      "SKIP_NON_PPC leads that were never upload candidates — and could not see day-5 failures at all.",
  };
}
