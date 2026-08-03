// Shared status classification, updated for the A5 delayed-push architecture
// (live since 2026-07-20, relay v10.9.7). Before A5, every relay row resolved
// same-day to SUCCESS / SUCCESS_EC_ONLY / FAILED / a true SKIP. Since A5, most
// rows now land in one of three ledger states that are NOT failures and NOT
// the old kind of skip — they're leads correctly waiting for their day-5 push:
//
//   A5_LEDGER_ONLY    — pre-day-5, positive-ladder stage, ledger updated, no push yet
//   A5_PENDING_LEDGER — pre-day-5, RNR/Not Reachable, ledger updated, no push. Day-5 job decides.
//   A5_NO_UPGRADE     — day-5 (or later) lookup found no stage change since ledger write
//
// Every tool that buckets relay-log statuses needs to treat these as their
// own category, not fold them into SKIPPED or an implicit "didn't reach
// GAds" bucket — doing so silently manufactures false "coverage hole" /
// "needs review" alarms for perfectly healthy leads that just haven't hit
// day 5 yet.
//
// IMPORTANT — a second, structural limitation this file does NOT fix:
// runDay5Push() (the scheduled sweep that actually performs the day-5 push)
// writes its outcome to Firestore + the BatchLog tab, NOT to the Log tab.
// So a lead's Log-tab row from its creation date will show A5_LEDGER_ONLY
// forever unless a *later webhook* happens to re-evaluate it — the
// successful day-5 push itself never appears in the Log tab against the
// origination date. Any tool that reconciles relay-vs-GAds by joining on
// Log-tab origination date (e.g. reconcile_relay_vs_gads) is structurally
// blind to day-5-swept conversions, even after this classification fix.
// Confirmed by direct Cloud Logging + Executions inspection, 2026-07-29 —
// see verify_batch_landed for the BatchLog-based volume check that DOES
// see day-5 outcomes, just not attributed back to a per-lead origination
// date. Treat Log-tab-only reconciliation as a lower bound, not a fact.

export const A5_STATUSES = new Set([
  "A5_LEDGER_ONLY",
  "A5_PENDING_LEDGER",
  "A5_NO_UPGRADE",
]);

export const A5_PUSH_DELAY_DAYS = 5;

export function isA5Pending(status: string | undefined): boolean {
  return !!status && A5_STATUSES.has(status);
}

// True skip = would have been a skip under the old model too (non-PPC source,
// dropped stage, etc.) — NOT a lead waiting in the A5 ledger.
export function isTrueSkip(status: string | undefined): boolean {
  return !!status && status.includes("SKIP") && !isA5Pending(status);
}

export function isFailed(status: string | undefined): boolean {
  return !!status && status.includes("FAIL");
}

// A date is "too recent for A5" if it hasn't yet cleared the day-5 window —
// treating it as a health failure (rather than "still pending") is exactly
// the false-alarm pattern this file exists to prevent.
export function isTooRecentForA5(dateStr: string, asOf: Date = new Date()): boolean {
  const rowDate = new Date(dateStr + "T00:00:00Z");
  const ageDays = (asOf.getTime() - rowDate.getTime()) / 86400000;
  return ageDays < A5_PUSH_DELAY_DAYS;
}

// ── BatchLog run classification (added 2026-08-03) ───────────────────────
//
// Addresses the structural limitation described in the header above. The
// day-5 blind spot was correctly closed as harmless on 2026-07-20 when the
// wave was ~1 push/day; measured 2026-08-03 it is 30-40/day, i.e. roughly
// HALF of all conversions delivered to Google Ads (258 day-5 vs 245
// forward-upgrade over 7 days). Tools reporting delivery volume must join
// BatchLog in or they under-report by ~2x.
//
// BatchLog is a shared tab: it holds day-5 push runs AND the retired
// runAdjustmentBatch runs (trigger removed 2026-07-20, function kept), plus
// pre-flip "DISABLED" rows from before ENABLE_A5_FORWARD_ONLY was set true.
// Only day-5 rows represent conversions delivered, so they must be isolated
// before their `processed` counts are summed.
//
// ASSUMPTION WORTH VERIFYING: day-5 runs are identified by the "eligible:"
// token, which runDay5Push() always writes into its BatchLog message
// (`'eligible:' + trueEligibleCount + ' remaining:' + remaining`). If that
// message format changes this classifier goes quietly wrong — which is why
// callers should surface the excluded counts rather than silently dropping
// unmatched rows.
export type BatchRunKind =
  | "day5_push"
  | "legacy_adjustment"
  | "disabled"
  | "no_op"
  | "unknown";

// `activity` = processed + dropped + failed for the run. Rows with zero
// activity cannot affect any total, so they are classified "no_op" rather
// than "unknown" — otherwise the unknown-count alarm fires permanently on
// harmless idle runs and stops meaning anything. Observed case: runDay5Push()
// on 7/21-7/23 found nothing eligible and wrote NO message column at all
// (5 cells, not 6), so the "eligible:" token cannot match.
export function classifyBatchRun(
  status: string,
  message: string,
  activity = 1
): BatchRunKind {
  const s = status || "";
  const m = message || "";
  if (m.includes("[LEGACY]")) return "legacy_adjustment";
  if (s.toUpperCase().includes("DISABLED") || m.includes("ENABLE_A5_FORWARD_ONLY is false")) {
    return "disabled";
  }
  if (m.includes("eligible:")) return "day5_push";
  if (activity === 0) return "no_op";
  return "unknown";
}
