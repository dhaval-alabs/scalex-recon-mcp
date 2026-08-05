import { readBatchLog } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";
import { A5_PUSH_DELAY_DAYS } from "../status-classify";

// Parse M/D/YYYY or YYYY-MM-DD to YYYY-MM-DD
function toIso(ts: string): string {
  const m = ts.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return ts.substring(0, 10);
}

// Verify recent restatement batches landed in Google Ads.
// FIX (Jun 16): BatchLog has no batchId column, and rows were being read
// oldest-first (surfacing May legacy HTTP_400 batches). readBatchLog now
// returns NEWEST-FIRST with the correct schema
// (timestamp/status/processed/dropped/failed/message).
// This tool now accepts an optional date filter instead of a non-existent
// batchId, and defaults to the latest N batches.
export async function verifyBatchLanded(params: {
  date?: string;     // optional YYYY-MM-DD — verify batches on this date
  lastN?: number;    // default 5 most-recent batches
}) {
  const { date, lastN = 5 } = params ?? {};

  const batches = await readBatchLog(100); // newest-first
  if (batches.length === 0) return { error: "No batch log entries found" };

  const targetBatches = date
    ? batches.filter((b) => toIso(b.timestamp) === date)
    : batches.slice(0, lastN);

  if (targetBatches.length === 0) {
    return {
      error: date
        ? `No batches found on ${date}`
        : "No recent batches found",
      latest_available: batches.slice(0, 3).map((b) => ({
        timestamp: b.timestamp,
        status: b.status,
      })),
    };
  }

  const results = await Promise.all(
    targetBatches.map(async (batch) => {
      try {
        const isoDate = toIso(batch.timestamp);

        // ── DATE OFFSET ────────────────────────────────────────────────────
        // This tool used to query Google for the SAME date as the batch push
        // and got zeros on every batch, which read as a landing failure.
        // Switching gads-client to the conversion-date axis does NOT by itself
        // fix that, because the two dates are different events:
        //
        //   runDay5Push() executes on date D, but uploads
        //   conversion_date_time = current_stage_changed_at || created_at,
        //   i.e. roughly D - A5_PUSH_DELAY_DAYS.
        //
        // So on the conversion-date axis Google files that push ~5 days BEFORE
        // the batch ran. Querying date D returns nothing. Look back instead,
        // with a buffer because leads that changed stage carry a later
        // conversion date than their creation date.
        const BUFFER_DAYS = 2;
        const windowEnd = isoDate;
        const windowStart = new Date(
          new Date(`${isoDate}T00:00:00Z`).getTime() -
            (A5_PUSH_DELAY_DAYS + BUFFER_DAYS) * 86400000
        )
          .toISOString()
          .substring(0, 10);

        const gadsRows = await getConversionsByDay(windowStart, windowEnd, ["sclx"]);
        const gadsTotal = gadsRows.reduce((s, r) => s + r.conversions, 0);
        const adjustmentRows = gadsRows.filter(
          (r) =>
            r.conversionAction.includes("qualified") ||
            r.conversionAction.includes("disqualified")
        );

        return {
          timestamp: batch.timestamp,
          batch_status: batch.status,
          processed: batch.processed,
          dropped: batch.dropped,
          failed: batch.failed,
          message: batch.message ? batch.message.substring(0, 160) : "",
          gads_conversion_date_window: `${windowStart} to ${windowEnd}`,
          gads_sclx_conversions_in_window: gadsTotal,
          gads_actions: adjustmentRows.map((r) => ({
            action: r.conversionAction,
            count: r.conversions,
          })),
          batch_health:
            batch.failed > 0
              ? "🔴 HAD_FAILURES"
              : batch.processed > 0
              ? "✅ RAN_CLEAN"
              : "➖ NOTHING_ELIGIBLE",
          gads_volume_present: gadsTotal > 0 ? "✅ YES" : "⚠️ NONE_IN_WINDOW",
          interpretation:
            "batch_health comes from BatchLog and is authoritative for whether the run itself " +
            "succeeded. gads_volume_present is CONTEXT ONLY — the window spans several days and " +
            "several conversion actions, so it cannot confirm that this specific batch's rows " +
            "landed. BatchLog carries no prospect IDs, and Google reports aggregates with no " +
            "per-record match field, so per-batch confirmation is not obtainable from either " +
            "side. Treat a clean batch plus non-zero window volume as consistent, not as proof.",
        };
      } catch (err) {
        return {
          timestamp: batch.timestamp,
          batch_status: batch.status,
          processed: batch.processed,
          failed: batch.failed,
          error: String(err),
        };
      }
    })
  );

  return {
    batches_checked: results.length,
    filter: date ? `date=${date}` : `latest ${lastN}`,
    results,
    note: "GAds conversion counts are per-day aggregates — use as a directional signal, not a precise per-batch match. BatchLog has no per-batch ID; matching is by date.",
  };
}
