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

  // ── DOUBLE-COUNT GUARD (added 2026-08-17) ──────────────────────────────
  // Relay v10.9.8 item 17 made runDay5Push() write its FAILURES into the Log
  // tab so their reasons could finally be read. That fix worked — it is how
  // the click-window cause was diagnosed. But this tool reads the Log tab as
  // the FORWARD-UPGRADE leg and BatchLog as the DAY-5 leg, so from 13 Aug
  // every day-5 failure was counted in BOTH.
  //
  // Measured on 12-17 Aug: 20 GADS_PARTIAL_FAIL rows in the Log tab, of which
  // 19 carried a DAY5 marker (14 "DAY5 PUSH FAILED" + 5 "DAY5 EXPIRED") and
  // exactly 1 was a genuine forward-upgrade failure. The 14 reconcile exactly
  // against BatchLog's own failure count for the same window — same events,
  // two places.
  //
  // Effect of the bug: forward-upgrade failure rate read 32.8% (20/61) when
  // the true rate was 2.3% (1/44), and the combined delivery error rate read
  // 15.04% against a true 7.18%. An independent review reported the 32.8% as
  // a live incident and proposed porting a relay fix to a path that did not
  // need it.
  //
  // Day-5 rows are identified by the marker runDay5Push() writes into the
  // message column. Both variants are matched: "DAY5 PUSH FAILED" (real
  // failure) and "DAY5 EXPIRED" (v10.9.9 terminal click-window
  // reclassification).
  const isDay5Row = (r: { message?: string }) => /DAY5 /.test(r.message || "");
  const day5RowsInLog = rows.filter(isDay5Row).length;
  const forwardRows = rows.filter((r) => !isDay5Row(r));

  const success = statusCounts.get("SUCCESS") ?? 0;
  const ecOnly = statusCounts.get("SUCCESS_EC_ONLY") ?? 0;

  // Failures counted over FORWARD rows only. Day-5 failures are counted once,
  // from BatchLog, in the day-5 leg below.
  const failed = forwardRows.filter((r) => isFailed(r.status || "")).length;
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

  // ── ATTACH RATE DENOMINATOR (fixed 2026-08-17) ─────────────────────────
  // gclid_attach_rate and ec_only_rate were both computed over ALL rows.
  // Measured 12-17 Aug: 274 gclid+ec / 1,372 rows = 20.0%, and ec_only_rate
  // was simply its complement at 80.0% — which folded 929 SKIP_NON_PPC rows
  // into "ec_only" despite those never being upload candidates at all.
  //
  // This matters beyond presentation: we have been quoting attach rate as the
  // delivery rate, in documents and to the client, on that denominator.
  //
  // Correct denominator is rows that actually carry an identifier, i.e. are
  // candidates for upload. Non-PPC skips carry none and are excluded.
  const candidateRows = rows.filter((r) => {
    const g = r.gclidSource || "none";
    return g === "gclid+ec" || g === "ec_only";
  });
  const candidates = candidateRows.length;
  const candGclid = candidateRows.filter((r) => r.gclidSource === "gclid+ec").length;
  const candEcOnly = candidateRows.filter((r) => r.gclidSource === "ec_only").length;

  // Pushed vs pending cannot be conflated: an A5_PENDING row is a candidate
  // that has not been attempted yet, so including it in a DELIVERY rate
  // measures intent rather than outcome. Reported separately.
  const candPending = candidateRows.filter((r) => isA5Pending(r.status || "")).length;
  const candAttempted = candidates - candPending;
  const attGclid = candidateRows.filter(
    (r) => r.gclidSource === "gclid+ec" && !isA5Pending(r.status || "")
  ).length;
  const cpct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

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
  // SUPERSEDED 2026-08-13 — the justification below is stale, the LOGIC IS NOT.
  // This block originally gated the cutoff tightening (GCLID_IMPORT_CUTOFF_DAYS
  // 90→75, EC_ONLY 63→58) on the grounds that the change RAISES expiry drops by
  // design. That proposal (task 5b) is DROPPED — see the full reasoning in the
  // `loss.gates` field below, which is the authoritative record. In short: the
  // rejections are a function of CLICK age while isPastImportCutoff() filters on
  // lead created_at, so a tighter wall discards landable leads. Fix is task 5c.
  //
  // KEEP THE LOGIC REGARDLESS. Gating the verdict on drops is correct whether or
  // not 5b ever ships: a drop is permanent signal loss where a failure is retried
  // on the next sweep, so without this the verdict would stay green while real
  // loss climbed. Only the 5b justification is stale.
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
        day5_rows_excluded_from_this_leg: day5RowsInLog,
        day5_exclusion_note:
          "Relay v10.9.8 writes day-5 FAILURES into the Log tab so their reasons are readable. " +
          "Those rows are excluded here and counted once, from BatchLog, in the day-5 leg. Before " +
          "this guard they were counted in both, which read as a 32.8% forward-upgrade failure " +
          "rate against a true 2.3% on 12-17 Aug.",
        failures: failed,
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
      // ── Correct denominators: upload candidates only ──────────────────
      gclid_attach_rate: cpct(attGclid, candAttempted),
      ec_only_rate: cpct(candAttempted - attGclid, candAttempted),
      attach_rate_basis: {
        note:
          "Computed over ATTEMPTED UPLOAD CANDIDATES only — rows carrying an identifier that have " +
          "already been pushed. Non-PPC skips carry no identifier and are excluded; A5_PENDING rows " +
          "are candidates not yet attempted and are excluded from the delivery-rate denominator. " +
          "The superseded *_log_rows_only figures below divided by ALL rows, which folded ~two " +
          "thirds SKIP_NON_PPC into 'ec_only' and understated attach rate by roughly 3x.",
        total_rows: total,
        upload_candidates: candidates,
        of_which_pending: candPending,
        attempted: candAttempted,
        attempted_with_gclid: attGclid,
        candidates_gclid_all: candGclid,
        candidates_ec_only_all: candEcOnly,
        still_biased:
          "Log-tab rows are forward upgrades, which are late-funnel and structurally GCLID-poor. " +
          "This is a corrected denominator on a still-biased sample. The day-5 leg carries no " +
          "per-row gclid data in BatchLog, so an account-wide attach rate needs Firestore.",
      },
      gclid_attach_rate_log_rows_only_SUPERSEDED: pct(gclidAttached),
      ec_only_rate_log_rows_only_SUPERSEDED: pct(gclidNone),
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
        "SUPERSEDED 2026-08-13 — do NOT read this as a plan. This field previously anticipated " +
        "tightening GCLID_IMPORT_CUTOFF_DAYS (90→75) and EC_ONLY_IMPORT_CUTOFF_DAYS (63→58). " +
        "That proposal (task 5b) is DROPPED. Reason, measured: every day-5 failure on 13 Aug " +
        "returned Google's error \"its click occurred before this conversion's click-through " +
        "window\", and all five _sclx actions already have clickThroughLookbackWindowDays=90, " +
        "which is Google's maximum. So the rejections are a function of CLICK age, while " +
        "isPastImportCutoff() filters on lead created_at — a proxy whose error margin is " +
        "unknown per lead. Tightening the created_at wall would therefore discard leads whose " +
        "clicks are still inside the window, to avoid sending ones Google rejects at no cost. " +
        "The fix is task 5c (capture the real click date at pixel time), which lets the " +
        "pre-flight check use the value Google actually measures. Relay v10.9.9 separately " +
        "marks these rejections terminal so they stop being retried nightly.",
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
