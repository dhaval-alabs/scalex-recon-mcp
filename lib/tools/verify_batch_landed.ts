import { readBatchLog } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";

export async function verifyBatchLanded(params: { batchId?: string; lastN?: number }) {
  const { batchId, lastN = 5 } = params;

  const batches = await readBatchLog(100);
  if (batches.length === 0) return { error: "No batch log entries found" };

  // Filter to requested batch or last N
  const targetBatches = batchId
    ? batches.filter((b) => b.batchId === batchId)
    : batches.slice(0, lastN);

  if (targetBatches.length === 0) {
    return { error: `No batch found with id: ${batchId}` };
  }

  // For each batch, check if GAds conversion counts moved after batch timestamp
  const results = await Promise.all(
    targetBatches.map(async (batch) => {
      const batchDate = batch.timestamp.substring(0, 10);
      // Check GAds for qualified + disqualified counts on batch date
      const gadsRows = await getConversionsByDay(batchDate, batchDate, ["qualified", "disqualified"]);
      const gadsTotal = gadsRows.reduce((s, r) => s + r.conversions, 0);

      return {
        batchId: batch.batchId,
        timestamp: batch.timestamp,
        rows_sent: batch.rowsSent,
        rows_accepted: batch.rowsAccepted,
        batch_status: batch.status,
        gads_conversions_on_date: gadsTotal,
        gads_actions: gadsRows.map((r) => ({
          action: r.conversionAction,
          count: r.conversions,
        })),
        landed: batch.rowsAccepted > 0 && gadsTotal > 0 ? "✅ LIKELY_LANDED" : "⚠️ VERIFY_MANUALLY",
      };
    })
  );

  return {
    batches_checked: results.length,
    results,
    note: "GAds conversion counts are per-day aggregates — use as a signal, not a precise per-batch match",
  };
}
