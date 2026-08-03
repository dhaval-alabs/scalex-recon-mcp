import { readRelayLogByDateRange } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";
import { isTooRecentForA5, A5_PUSH_DELAY_DAYS } from "../status-classify";

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
      status: isTooRecentForA5(date)
        ? "⏳ TOO_RECENT_FOR_A5"
        : Math.abs(gap) <= 2
        ? "✅ OK"
        : gap > 0
        ? "⚠️ RELAY_AHEAD"
        : "🔴 GADS_AHEAD",
    };
  });

  // Only dates that have actually cleared the A5 delay window are a fair
  // test of whether relay-sent and Google-Ads-received line up. Recent dates
  // are excluded from the health/gap total, not just individually labeled,
  // or a run of fresh zero-vs-zero days would still average into "healthy"
  // for the wrong reason and mask a real gap in the matured cohort.
  const maturedRows = diffTable.filter((r) => r.status !== "⏳ TOO_RECENT_FOR_A5");

  // This tool takes an explicit date range (there is no default lookback to
  // widen), so guarding SAMPLE SIZE is what actually prevents a verdict being
  // issued on too little matured data. A 7-day range leaves only ~2 usable
  // days once the A5 window is excluded — not enough to call either way.
  const MIN_MATURED_DAYS = 7;
  const insufficientSample = maturedRows.length < MIN_MATURED_DAYS;
  const totalRelaySent = maturedRows.reduce((s, r) => s + r.relay_total_sent, 0);
  const totalGads = maturedRows.reduce((s, r) => s + r.gads_lead_submitted, 0);
  const totalGap = totalRelaySent - totalGads;
  const overallGapPct = totalRelaySent > 0 ? ((totalGap / totalRelaySent) * 100).toFixed(1) : "0.0";

  return {
    summary: {
      period: `${startDate} to ${endDate}`,
      matured_dates_only_note: `Totals below only include dates ${A5_PUSH_DELAY_DAYS}+ days old — recent dates are still inside the A5 delay window and are reported per-day but excluded from the health verdict.`,
      structural_caveat: "runDay5Push() writes outcomes to Firestore + BatchLog, not the Log tab. This tool joins on Log-tab origination date only, so it is structurally blind to a day-5 push that succeeds without a later webhook re-touching that same Log row. A clean result here is a lower bound, not proof every matured lead landed — cross-check volume with verify_batch_landed, which reads BatchLog directly.",
      relay_total_sent: totalRelaySent,
      gads_total_received: totalGads,
      total_gap: totalGap,
      gap_pct: `${overallGapPct}%`,
      matured_days_used: maturedRows.length,
      health: insufficientSample
        ? "❔ INSUFFICIENT_MATURED_SAMPLE"
        : Math.abs(totalGap) / Math.max(totalRelaySent, 1) < 0.05
        ? "✅ HEALTHY"
        : "⚠️ NEEDS_REVIEW",
      ...(insufficientSample
        ? {
            sample_warning:
              `Only ${maturedRows.length} matured day(s) in this range (need ${MIN_MATURED_DAYS}+). ` +
              `The A5 ${A5_PUSH_DELAY_DAYS}-day delay consumes the most recent dates, so request a range of ` +
              `at least ${MIN_MATURED_DAYS + A5_PUSH_DELAY_DAYS} days to get a verdict.`,
          }
        : {}),
    },
    daily_diff: diffTable,
  };
}
