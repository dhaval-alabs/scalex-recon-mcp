import { readRelayLogByDateRange, readBatchLogByDateRange, parseRowDate } from "../sheets-client";
import { getConversionsByDay } from "../gads-client";
import { isTooRecentForA5, A5_PUSH_DELAY_DAYS, isA5Pending, classifyBatchRun } from "../status-classify";

// parseRowDate comes from sheets-client rather than being redefined here — this
// file used to carry its own identical copy, which is the drift the shared
// export exists to prevent.

// ── WHAT THIS TOOL CAN AND CANNOT PROVE ───────────────────────────────────
//
// Two legs deliver conversions to Google Ads, and only ONE is per-date
// verifiable from the Log tab:
//
// 1. IMMEDIATE pushes (forward upgrades, disqualifications). The Log records
//    the outcome and the conversion_date_time is "now", so row date == Google
//    conversion date. Fully reconcilable per date and per bucket.
//
// 2. DAY-5 initial pushes. runDay5Push() writes to BatchLog/Firestore only,
//    and uploads whichever bucket the lead occupies AT day 5 — not the bucket
//    implied by the ledger row we can see. Post-A5, only 423 of 757 ledger
//    rows targeted LEAD_SUBMITTED; 334 were destined for qualified/signup/
//    converted. Worse, when a lead moves stage several times during its hold,
//    only the LAST ledger state actually pushes, and the Log cannot tell us
//    which row that was.
//
// An earlier version of this tool counted every ledger row as an expected
// lead_submitted, which produced a spurious 25% RELAY_AHEAD gap that looked
// like signal loss and was not. Rather than build a more elaborate guess, the
// day-5 leg is now reconciled at WINDOW-VOLUME level only, and excluded from
// the per-date verdict. Per-date day-5 attribution requires Firestore.

// ── BUCKET RESOLUTION ─────────────────────────────────────────────────────
// Read the bucket the relay ACTUALLY USED, from its own log message. Deriving
// it from a stage table was a mistake: the table omitted RNR, Not Reachable
// and Marketing Lead, which pre-A5 pushed ₹1 disqualifications — 558 real
// pushes counted as zero. That alone produced a fake "-274% GADS_AHEAD
// anomaly" on pre-A5 DISQUALIFIED which was nearly written up as a pipeline
// finding. With those rows counted the bucket reads +53% RELAY_AHEAD, the
// same direction as every other bucket.
//
// Message formats, in priority order:
//   pre-A5 immediate : "✅ ₹1 sent | ... | bucket:DISQUALIFIED | stage:RNR"
//   post-A5 upgrade  : "A5: forward upgrade to CONVERTED pushed immediately"
//   post-A5 disqual  : "A5: disqualified ₹1 sent | no restatement cascade"
//   ledger rows      : "A5: pre-day5, stage=QUALIFIED — ledger updated"
// The stage table is a last-resort fallback only.
function resolveBucket(message: string, newStage: string): string | null {
  const m = message || "";
  const explicit = m.match(/bucket:([A-Z_]+)/);
  if (explicit) return explicit[1];
  const upgrade = m.match(/forward upgrade to ([A-Z_]+)/);
  if (upgrade) return upgrade[1];
  if (/disqualified ₹1 sent/.test(m)) return "DISQUALIFIED";
  const staged = m.match(/stage=([A-Z_]+)/);
  if (staged) return staged[1];
  return STAGE_TO_BUCKET[newStage] ?? null;
}

const STAGE_TO_BUCKET: Record<string, string> = {
  "New Lead": "LEAD_SUBMITTED",
  "Future Interest": "SIGNUP",
  "ML-Enquiry": "SIGNUP",
  Enquiry: "QUALIFIED",
  "Re-Enquiry": "QUALIFIED",
  Hot: "QUALIFIED",
  Warm: "QUALIFIED",
  "Priority-Call": "QUALIFIED",
  Enrolled: "CONVERTED",
  Junk: "DISQUALIFIED",
  "Not Interested": "DISQUALIFIED",
  Disqualified: "DISQUALIFIED",
  Cold: "DISQUALIFIED",
};

// A5 went live 2026-07-20. Before that every push was immediate, so the Log
// records the whole picture and all buckets are comparable per-date. After it,
// only DISQUALIFIED remains purely immediate — a disqualification fires at
// stage-change time and is never deferred. LEAD_SUBMITTED / QUALIFIED /
// SIGNUP / CONVERTED all additionally receive day-5 volume that the Log cannot
// see, so an immediate-only count is a LOWER BOUND for them and Google will
// legitimately be ahead. Comparing those per-date produces false GADS_AHEAD.
const A5_GOLIVE = "2026-07-20";

function isComparable(date: string, bucket: string): boolean {
  if (date < A5_GOLIVE) return true;
  return bucket === "DISQUALIFIED";
}

const BUCKET_TO_ACTION: Record<string, string> = {
  LEAD_SUBMITTED: "lead_submitted",
  SIGNUP: "signup",
  QUALIFIED: "qualified",
  CONVERTED: "converted",
  DISQUALIFIED: "disqualified",
};

export async function reconcileRelayVsGads(params: { startDate: string; endDate: string }) {
  const { startDate, endDate } = params;

  const [relayRows, batchRows, gadsRows] = await Promise.all([
    readRelayLogByDateRange(startDate, endDate),
    readBatchLogByDateRange(startDate, endDate),
    getConversionsByDay(startDate, endDate, ["sclx"]),
  ]);

  // ── Leg 1: immediate pushes, keyed (date, bucket) ───────────────────────
  type Cell = { pushed: number; failed: number; seen: Set<string>; dupes: number };
  const immediate = new Map<string, Cell>();
  const awaitingByDate = new Map<string, number>();

  for (const r of relayRows) {
    const date = parseRowDate(r.timestamp);
    if (!date) continue;

    if (isA5Pending(r.status)) {
      awaitingByDate.set(date, (awaitingByDate.get(date) ?? 0) + 1);
      continue;
    }

    const isPush = r.status === "SUCCESS" || r.status === "SUCCESS_EC_ONLY";
    const isFail = !!r.status && r.status.includes("FAIL");
    if (!isPush && !isFail) continue;

    const bucket = resolveBucket(r.message, r.newStage);
    if (!bucket) continue; // genuinely unresolvable — no push recorded
    const key = `${date}||${bucket}`;
    const cell = immediate.get(key) ?? { pushed: 0, failed: 0, seen: new Set<string>(), dupes: 0 };

    // Dedupe only on a REAL identity. An earlier version used
    // `prospectId || gclid+"|"+email`, which evaluates to the truthy string
    // "|" when all three are blank — collapsing every identity-less row into
    // one. Most were skips, but ec_only ledger rows with no gclid/email were
    // silently dropped from the count too.
    const identity = r.prospectId || (r.gclid ? `g:${r.gclid}` : "") || (r.email ? `e:${r.email}` : "");
    if (identity) {
      if (cell.seen.has(identity)) {
        cell.dupes++;
        immediate.set(key, cell);
        continue;
      }
      cell.seen.add(identity);
    }

    if (isPush) cell.pushed++;
    else cell.failed++;
    immediate.set(key, cell);
  }

  // ── Google side, keyed (date, bucket) ───────────────────────────────────
  const gadsCell = new Map<string, number>();
  const gadsTotalsByBucket = new Map<string, number>();
  for (const g of gadsRows) {
    const action = g.conversionAction.toLowerCase();
    // disqualified must be tested before qualified — "disqualified" contains it
    const bucket = action.includes("disqualified")
      ? "DISQUALIFIED"
      : action.includes("qualified")
      ? "QUALIFIED"
      : action.includes("lead_submitted")
      ? "LEAD_SUBMITTED"
      : action.includes("converted")
      ? "CONVERTED"
      : action.includes("signup")
      ? "SIGNUP"
      : "";
    if (!bucket) continue;
    gadsCell.set(`${g.date}||${bucket}`, (gadsCell.get(`${g.date}||${bucket}`) ?? 0) + g.conversions);
    gadsTotalsByBucket.set(bucket, (gadsTotalsByBucket.get(bucket) ?? 0) + g.conversions);
  }

  const allKeys = Array.from(new Set([...immediate.keys(), ...gadsCell.keys()]));
  const perBucket = allKeys
    .map((key) => {
      const [date, bucket] = key.split("||");
      const cell = immediate.get(key) ?? { pushed: 0, failed: 0, seen: new Set<string>(), dupes: 0 };
      const received = gadsCell.get(key) ?? 0;
      const gap = cell.pushed - received;
      return {
        date,
        bucket,
        gads_action: BUCKET_TO_ACTION[bucket] ?? bucket,
        relay_pushed_immediately: cell.pushed,
        relay_duplicates_ignored: cell.dupes,
        relay_failed: cell.failed,
        gads_received: received,
        gap,
        comparable: isComparable(date, bucket),
        status: isTooRecentForA5(date)
          ? "⏳ TOO_RECENT_FOR_A5"
          : !isComparable(date, bucket)
          ? "◐ DAY5_ALSO_DELIVERS"
          : cell.pushed === 0 && received === 0
          ? "➖ NO_VOLUME"
          : Math.abs(gap) <= 2
          ? "✅ OK"
          : gap > 0
          ? "⚠️ RELAY_AHEAD"
          : "🔴 GADS_AHEAD",
      };
    })
    .sort((a, b) => (a.date === b.date ? a.bucket.localeCompare(b.bucket) : b.date.localeCompare(a.date)));

  const matured = perBucket.filter(
    (r) =>
      r.status !== "⏳ TOO_RECENT_FOR_A5" &&
      r.status !== "➖ NO_VOLUME" &&
      r.status !== "◐ DAY5_ALSO_DELIVERS"
  );
  const MIN_MATURED_CELLS = 7;
  const insufficient = matured.length < MIN_MATURED_CELLS;

  // PER-BUCKET, never one cross-bucket total. A single aggregate let a large
  // RELAY_AHEAD on DISQUALIFIED cancel a large GADS_AHEAD elsewhere and report
  // ✅ HEALTHY at -4.8% while both sides were badly out. Opposite-signed gaps
  // in different buckets are different problems and must not net off.
  // Split by bucket AND by A5 era. DISQUALIFIED is comparable on both sides of
  // the flip, and its two sides run in OPPOSITE directions — pre-A5 Google is
  // ~3.5x ahead, post-A5 the relay is ~5.4x ahead, with the sign flipping on
  // 2026-07-21. Averaging them produced -36% and concealed both. Never
  // aggregate across a known regime change.
  const byKey = new Map<string, { pushed: number; received: number; cells: number }>();
  for (const r of matured) {
    const era = r.date < A5_GOLIVE ? "pre_a5" : "post_a5";
    const k = `${r.bucket}||${era}`;
    const b = byKey.get(k) ?? { pushed: 0, received: 0, cells: 0 };
    b.pushed += r.relay_pushed_immediately;
    b.received += r.gads_received;
    b.cells++;
    byKey.set(k, b);
  }
  const bucketVerdicts = Array.from(byKey.entries())
    .map(([k, b]) => {
      const [bucket, era] = k.split("||");
      const g = b.pushed - b.received;
      const rate = b.pushed > 0 ? Math.abs(g) / b.pushed : 0;
      return {
        bucket,
        era,
        comparable_cells: b.cells,
        relay_pushed: b.pushed,
        gads_received: b.received,
        gap: g,
        gap_pct: b.pushed > 0 ? `${((g / b.pushed) * 100).toFixed(1)}%` : "n/a",
        verdict: rate < 0.05 ? "✅ HEALTHY" : g > 0 ? "⚠️ RELAY_AHEAD" : "🔴 GADS_AHEAD",
      };
    })
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  const worst = bucketVerdicts.find((b) => b.verdict !== "✅ HEALTHY");
  const totalPushed = matured.reduce((s, r) => s + r.relay_pushed_immediately, 0);
  const totalReceived = matured.reduce((s, r) => s + r.gads_received, 0);
  const gap = totalPushed - totalReceived;

  // ── Leg 2: day-5, window volume only ────────────────────────────────────
  const day5Runs = batchRows.filter(
    (b) =>
      classifyBatchRun(b.status, b.message, (b.processed || 0) + (b.dropped || 0) + (b.failed || 0)) ===
      "day5_push"
  );
  const day5Pushed = day5Runs.reduce((s, b) => s + (b.processed || 0), 0);
  const day5Failed = day5Runs.reduce((s, b) => s + (b.failed || 0), 0);
  const awaitingTotal = Array.from(awaitingByDate.values()).reduce((s, n) => s + n, 0);

  return {
    summary: {
      period: `${startDate} to ${endDate}`,
      date_axis:
        "Google queried on all_conversions_by_conversion_date, so segments.date is the CONVERSION " +
        "date and aligns with relay row dates. Previously click-dated, which made this comparison " +
        "structurally invalid.",
      scope:
        "The per-date verdict covers IMMEDIATE pushes only (forward upgrades and disqualifications), " +
        "which the Log records definitively. The day-5 leg is reported as window volume below and is " +
        "deliberately EXCLUDED from the verdict — see day5_why_not_per_date.",
      comparability:
        "Pre-2026-07-20 every push was immediate, so all buckets are comparable per-date. " +
        "Post-A5 only DISQUALIFIED is (it never defers to day 5); the other buckets also receive " +
        "day-5 volume invisible to the Log, so an immediate-only count is a lower bound there and " +
        "Google being ahead is expected, not a fault. Those cells are marked ◐ DAY5_ALSO_DELIVERS " +
        "and excluded from every verdict.",
      per_bucket_per_era: bucketVerdicts,
      known_anomalies:
        "DISQUALIFIED runs in opposite directions either side of A5 go-live and neither direction " +
        "is explained. PRE-A5: Google records several times what the relay pushed — something other " +
        "than the immediate path was writing disqualified conversions, and it stops at 2026-07-20 " +
        "(the legacy runAdjustmentBatch trigger was retired that day, but restatements adjust " +
        "existing conversions rather than create them, so that explanation is unconfirmed). " +
        "POST-A5: the relay pushes several times what Google records, on near-100% ec_only traffic, " +
        "consistent with EC identifier match failure but not demonstrated. Neither is resolvable " +
        "from the Log — both need offline_conversion_upload_conversion_action_summary (Layer 2), " +
        "which separates 'Google rejected the upload' from 'Google accepted it and did not match'.",
      immediate_leg: {
        relay_pushed: totalPushed,
        gads_received: totalReceived,
        gap,
        gap_pct: totalPushed > 0 ? `${((gap / totalPushed) * 100).toFixed(1)}%` : "0.0%",
        cross_bucket_total_warning:
          "This total spans buckets and can hide opposite-signed gaps cancelling out — read " +
          "per_bucket above, not this. Retained only for continuity.",
        matured_cells_used: matured.length,
        health: insufficient
          ? "❔ INSUFFICIENT_MATURED_SAMPLE"
          : worst
          ? `⚠️ NEEDS_REVIEW — worst bucket ${worst.bucket} at ${worst.gap_pct}`
          : "✅ HEALTHY",
        ...(insufficient
          ? {
              sample_warning:
                `Only ${matured.length} matured date/bucket cell(s) (need ${MIN_MATURED_CELLS}+). ` +
                `The A5 ${A5_PUSH_DELAY_DAYS}-day window consumes recent dates; widen the range.`,
            }
          : {}),
      },
      day5_leg: {
        pushes_executed: day5Pushed,
        failures: day5Failed,
        ledger_rows_awaiting_in_window: awaitingTotal,
        why_not_per_date:
          "runDay5Push() uploads whichever bucket the lead occupies AT day 5, not the bucket implied " +
          "by the ledger row visible here — post-A5 only 423 of 757 ledger rows targeted " +
          "LEAD_SUBMITTED. And when a lead changes stage repeatedly during its hold, only the last " +
          "ledger state pushes, which the Log cannot identify. Counting ledger rows as expected " +
          "lead_submitted produced a spurious ~25% gap that looked like loss and was not. " +
          "Per-date day-5 attribution needs Firestore.",
      },
      gads_totals_by_bucket: Object.fromEntries(gadsTotalsByBucket),
    },
    per_date_bucket: perBucket,
  };
}
