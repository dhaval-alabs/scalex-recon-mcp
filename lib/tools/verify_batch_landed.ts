import { readBatchLog } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";

export async function verifyBatchLanded(params: { batchId?: string; lastN?: number }) {
  const { batchId, lastN = 5 } = params;

  const batches = await readBatchLog(100);
  if (batches.length === 0) return { error: "No batch log entries found" };

  const targetBatches = batchId
    ? batches.filter((b) => b.batchId === batchId)
    : batches.slice(0, lastN);

  if (targetBatches.length === 0) {
    return { error: `No batch found with id: ${batchId}` };
  }

  // For each batch check GAds conversion counts on batch date
  const results = await Promise.all(
    targetBatches.map(async (batch) => {
      try {
        const batchDate = batch.timestamp.substring(0, 10);
        // Parse M/D/YYYY format
        const mdyMatch = batchDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const isoDate = mdyMatch
          ? `${mdyMatch[3]}-${mdyMatch[1].padStart(2, "0")}-${mdyMatch[2].padStart(2, "0")}`
          : batchDate;

        const gadsRows = await getConversionsByDay(isoDate, isoDate, ["sclx"]);
        const gadsTotal = gadsRows.reduce((s, r) => s + r.conversions, 0);
        const qualifiedRows = gadsRows.filter(r => r.conversionAction.includes("qualified") || r.conversionAction.includes("disqualified"));

        return {
          batchId: batch.batchId,
          timestamp: batch.timestamp,
          rows_sent: batch.rowsSent,
          rows_accepted: batch.rowsAccepted,
          batch_status: batch.status,
          gads_sclx_conversions_on_date: gadsTotal,
          gads_actions: qualifiedRows.map((r) => ({
            action: r.conversionAction,
            count: r.conversions,
          })),
          landed: batch.rowsAccepted > 0 && gadsTotal > 0 ? "✅ LIKELY_LANDED" : "⚠️ VERIFY_MANUALLY",
        };
      } catch (err) {
        return {
          batchId: batch.batchId,
          timestamp: batch.timestamp,
          rows_sent: batch.rowsSent,
          batch_status: batch.status,
          error: String(err),
        };
      }
    })
  );

  return {
    batches_checked: results.length,
    results,
    note: "GAds conversion counts are per-day aggregates — use as a signal, not a precise per-batch match",
  };
}
