import { readBatchLog } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";

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
        const gadsRows = await getConversionsByDay(isoDate, isoDate, ["sclx"]);
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
          gads_sclx_conversions_on_date: gadsTotal,
          gads_actions: adjustmentRows.map((r) => ({
            action: r.conversionAction,
            count: r.conversions,
          })),
          landed:
            batch.processed > 0 && batch.failed === 0 && gadsTotal > 0
              ? "✅ LIKELY_LANDED"
              : batch.failed > 0
              ? "🔴 HAD_FAILURES"
              : "⚠️ VERIFY_MANUALLY",
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
