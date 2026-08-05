import { readRelayLogByDateRange, readBatchLogByDateRange, parseRowDate } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";
import { isTooRecentForA5, A5_PUSH_DELAY_DAYS, isA5Pending, classifyBatchRun } from "../status-classify";

// parseRowDate is imported from sheets-client rather than redefined here — this
// file previously carried its own identical copy, which is exactly the drift
// the shared export exists to prevent.

export async function reconcileRelayVsGads(params: {
  startDate: string;
  endDate: string;
}) {
  const { startDate, endDate } = params;

  const relayRows = await readRelayLogByDateRange(startDate, endDate);

  // ── NUMERATOR ────────────────────────────────────────────────────────────
  // This was returning ZERO for every post-A5 date, and issuing red verdicts
  // (and worse, ✅ OK on low-volume days where the gap fell inside tolerance)
  // against an empty relay side.
  //
  // Why it was zero: post-A5 a "New Lead" webhook writes A5_LEDGER_ONLY or
  // A5_PENDING_LEDGER, never SUCCESS — the first push happens later in
  // runDay5Push(). The old code counted only SUCCESS/SUCCESS_EC_ONLY, so the
  // numerator was zero by construction from 2026-07-20 onward.
  //
  // Why the Log tab is still the right place to join: runDay5Push() uploads
  // conversion_date_time = current_stage_changed_at || created_at — the
  // ORIGINAL stage-change moment, not the push moment. Now that Google is
  // queried on the conversion-date axis, it files that push under the same
  // date as this Log row. So the Log's DATES were always correct; only the
  // status filter was wrong.
  //
  // DEDUPE: one prospect can emit several "New Lead" rows minutes apart (the
  // same GCLID and hashed identifiers repeating). Google's Count=One setting
  // records one conversion per click, so counting rows overstates the
  // numerator. Dedupe per date on prospectId, falling back to gclid+email.
  const relayByDate = new Map<
    string,
    {
      attempted: number;
      pushedNow: number;
      awaitingDay5: number;
      failed: number;
      seen: Set<string>;
      dupes: number;
    }
  >();
  for (const r of relayRows) {
    if (r.newStage !== "New Lead") continue; // only New Lead rows map to lead_submitted_sclx
    const date = parseRowDate(r.timestamp);
    if (!date) continue;
    const existing =
      relayByDate.get(date) ??
      { attempted: 0, pushedNow: 0, awaitingDay5: 0, failed: 0, seen: new Set<string>(), dupes: 0 };
    existing.attempted++;

    const identity = r.prospectId || `${r.gclid}|${r.email}` || "";
    if (identity && existing.seen.has(identity)) {
      existing.dupes++;
      relayByDate.set(date, existing);
      continue;
    }
    if (identity) existing.seen.add(identity);

    if (r.status === "SUCCESS" || r.status === "SUCCESS_EC_ONLY") existing.pushedNow++;
    else if (isA5Pending(r.status)) existing.awaitingDay5++;
    else if (r.status?.includes("FAIL")) existing.failed++;
    relayByDate.set(date, existing);
  }

  // Independent volume cross-check: day-5 pushes actually executed in this
  // window, straight from BatchLog. NOTE this is keyed on PUSH date, ~5 days
  // after the conversion date it carries, so it is a total-volume sanity check
  // only — deliberately not joined per-date.
  const batchRows = await readBatchLogByDateRange(startDate, endDate);
  const day5Runs = batchRows.filter(
    (b) =>
      classifyBatchRun(
        b.status,
        b.message,
        (b.processed || 0) + (b.dropped || 0) + (b.failed || 0)
      ) === "day5_push"
  );
  const day5PushedInWindow = day5Runs.reduce((s, b) => s + (b.processed || 0), 0);

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
    const relay =
      relayByDate.get(date) ??
      { attempted: 0, pushedNow: 0, awaitingDay5: 0, failed: 0, seen: new Set<string>(), dupes: 0 };
    const gadsCount = gadsByDate.get(date) ?? 0;
    // Expected = pushed immediately + those the day-5 sweep will file under
    // THIS date. For matured dates the sweep has already run, so expected
    // should equal delivered.
    const relayExpected = relay.pushedNow + relay.awaitingDay5;
    const gap = relayExpected - gadsCount;
    const gapPct = relayExpected > 0 ? ((gap / relayExpected) * 100).toFixed(1) : "0.0";
    const tooRecent = isTooRecentForA5(date);

    return {
      date,
      relay_rows: relay.attempted,
      relay_duplicate_rows_ignored: relay.dupes,
      relay_pushed_immediately: relay.pushedNow,
      relay_awaiting_day5: relay.awaitingDay5,
      relay_failed: relay.failed,
      relay_expected_sent: relayExpected,
      gads_lead_submitted: gadsCount,
      gap,
      gap_pct: `${gapPct}%`,
      status: tooRecent
        ? "⏳ TOO_RECENT_FOR_A5"
        : relayExpected === 0 && gadsCount === 0
        ? "➖ NO_VOLUME"
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
  // NO_VOLUME days are excluded too: a 0-vs-0 day is not evidence of health,
  // and a run of them would previously average a real gap away to nothing.
  const maturedRows = diffTable.filter(
    (r) => r.status !== "⏳ TOO_RECENT_FOR_A5" && r.status !== "➖ NO_VOLUME"
  );

  // This tool takes an explicit date range (there is no default lookback to
  // widen), so guarding SAMPLE SIZE is what actually prevents a verdict being
  // issued on too little matured data. A 7-day range leaves only ~2 usable
  // days once the A5 window is excluded — not enough to call either way.
  const MIN_MATURED_DAYS = 7;
  const insufficientSample = maturedRows.length < MIN_MATURED_DAYS;
  const totalRelaySent = maturedRows.reduce((s, r) => s + r.relay_expected_sent, 0);
  const totalGads = maturedRows.reduce((s, r) => s + r.gads_lead_submitted, 0);
  const totalGap = totalRelaySent - totalGads;
  const overallGapPct = totalRelaySent > 0 ? ((totalGap / totalRelaySent) * 100).toFixed(1) : "0.0";

  return {
    summary: {
      period: `${startDate} to ${endDate}`,
      matured_dates_only_note: `Totals below only include dates ${A5_PUSH_DELAY_DAYS}+ days old — recent dates are still inside the A5 delay window and are reported per-day but excluded from the health verdict.`,
      date_axis: "Google Ads queried on all_conversions_by_conversion_date, so segments.date is the CONVERSION date and aligns with relay row dates. Previously click-dated, which made this comparison structurally invalid.",
      numerator_basis:
        "relay_expected_sent = pushed-immediately + awaiting-day-5. Post-A5 a New Lead row writes " +
        "A5_LEDGER_ONLY/A5_PENDING_LEDGER, so counting only SUCCESS gave a zero numerator on every " +
        "post-A5 date. For MATURED dates the day-5 sweep has already run, so expected should equal " +
        "delivered; for recent dates it is a forecast, which is why they are excluded from the verdict.",
      remaining_limitation:
        "The day-5 leg is an EXPECTATION derived from ledger rows, not per-prospect confirmation — " +
        "BatchLog is aggregate and has no prospect IDs. A lead whose day-5 push failed permanently " +
        "would still be counted as expected here. Confirming per-prospect needs Firestore.",
      day5_pushes_executed_in_window: day5PushedInWindow,
      day5_volume_note:
        "From BatchLog, keyed on PUSH date (~5 days after the conversion date it carries), so this is " +
        "a total-volume cross-check only and is deliberately NOT joined per-date.",
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
