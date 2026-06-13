import { readRelayLogByDateRange } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";

// Parse M/D/YYYY or YYYY-MM-DD to YYYY-MM-DD
function parseDate(ts: string): string {
  if (!ts) return "";
  const mdy = ts.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  return ts.substring(0, 10);
}

export async function reconcileRelayVsGads(params: {
  startDate: string;
  endDate: string;
}) {
  const { startDate, endDate } = params;

  const relayRows = await readRelayLogByDateRange(startDate, endDate);

  // Count relay by YYYY-MM-DD date
  const relayByDate = new Map<string, { attempted: number; success: number; ecOnly: number; failed: number }>();
  for (const r of relayRows) {
    if (r.newStage !== "New Lead") continue; // only New Lead rows match lead_submitted_sclx
    const date = parseDate(r.timestamp);
    if (!date) continue;
    const existing = relayByDate.get(date) ?? { attempted: 0, success: 0, ecOnly: 0, failed: 0 };
    existing.attempted++;
    if (r.status === "SUCCESS") existing.success++;
    else if (r.status === "SUCCESS_EC_ONLY") existing.ecOnly++;
    else if (r.status?.includes("FAIL")) existing.failed++;
    relayByDate.set(date, existing);
  }

  // Pull GAds lead_submitted conversions by day
  const gadsRows = await getConversionsByDay(startDate, endDate, ["lead_submitted"]);

  const gadsByDate = new Map<string, number>();
  for (const r of gadsRows) {
    if (r.conversionAction.includes("lead_submitted")) {
      gadsByDate.set(r.date, (gadsByDate.get(r.date) ?? 0) + r.conversions);
    }
  }

  // Build diff table — all dates in YYYY-MM-DD
  const allDates = Array.from(
    new Set([...relayByDate.keys(), ...gadsByDate.keys()])
  ).sort().reverse();

  const diffTable = allDates.map((date) => {
    const relay = relayByDate.get(date) ?? { attempted: 0, success: 0, ecOnly: 0, failed: 0 };
    const gadsCount = gadsByDate.get(date) ?? 0;
    const relayTotal = relay.success + relay.ecOnly;
    const gap = relayTotal - gadsCount;
    const gapPct = relayTotal > 0 ? ((gap / relayTotal) * 100).toFixed(1) : "0.0";

    return {
      date,
      relay_attempted: relay.attempted,
      relay_success: relay.success,
      relay_ec_only: relay.ecOnly,
      relay_failed: relay.failed,
      relay_total_sent: relayTotal,
      gads_lead_submitted: gadsCount,
      gap,
      gap_pct: `${gapPct}%`,
      status: Math.abs(gap) <= 2 ? "✅ OK" : gap > 0 ? "⚠️ RELAY_AHEAD" : "🔴 GADS_AHEAD",
    };
  });

  const totalRelaySent = diffTable.reduce((s, r) => s + r.relay_total_sent, 0);
  const totalGads = diffTable.reduce((s, r) => s + r.gads_lead_submitted, 0);
  const totalGap = totalRelaySent - totalGads;
  const overallGapPct = totalRelaySent > 0 ? ((totalGap / totalRelaySent) * 100).toFixed(1) : "0.0";

  return {
    summary: {
      period: `${startDate} to ${endDate}`,
      relay_total_sent: totalRelaySent,
      gads_total_received: totalGads,
      total_gap: totalGap,
      gap_pct: `${overallGapPct}%`,
      health: Math.abs(totalGap) / Math.max(totalRelaySent, 1) < 0.05 ? "✅ HEALTHY" : "⚠️ NEEDS_REVIEW",
    },
    daily_diff: diffTable,
  };
}
