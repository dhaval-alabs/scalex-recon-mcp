import { readRelayLogByDateRange } from "../sheets-client";
import { isFailed, isDay5Row, isUploadCandidate, isA5Pending } from "../status-classify";

// Parse M/D/YYYY or YYYY-MM-DD timestamps to YYYY-MM-DD
function parseRowDate(timestamp: string): string {
  if (!timestamp) return "";
  const mdyMatch = timestamp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return timestamp.substring(0, 10);
}

export async function getSignalQualityTrend(params: {
  days?: number;
  granularity?: "daily" | "weekly";
}) {
  const { days = 30, granularity = "daily" } = params;
  const endDate = new Date().toISOString().substring(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);

  const allRows = await readRelayLogByDateRange(startDate, endDate);
  if (allRows.length === 0) return { error: "No rows found for period" };

  // ── AUDIT FIX 2026-08-20 ────────────────────────────────────────────────
  // This tool divided all three metrics by EVERY Log row, which carried two
  // defects already found and fixed elsewhere but never here:
  //
  //   gclid_attach_rate / ec_only_rate — denominator was all rows, roughly two
  //     thirds of which are SKIP_NON_PPC and were never upload candidates. That
  //     understated attach rate about threefold (20% reported vs 63% on the
  //     correct denominator) and made ec_only_rate its meaningless complement,
  //     counting a non-PPC skip with no identifier at all as "ec_only".
  //     Same defect fixed in get_relay_health on 18 Aug.
  //
  //   error_rate — counted the day-5 FAILURE rows that relay v10.9.8 item 17
  //     writes into the Log tab. This codebase reads the Log tab as the
  //     forward-upgrade leg and BatchLog as the day-5 leg, so those rows were
  //     counted in both. Same double-count fixed in get_relay_health on 17 Aug.
  //
  // Both now use the shared definitions in status-classify so the two tools
  // cannot disagree again.
  const day5Excluded = allRows.filter((r) => isDay5Row(r.message)).length;
  const rows = allRows.filter((r) => !isDay5Row(r.message));

  // Group by date using parseRowDate
  const byDate = new Map<
    string,
    {
      total: number;          // all forward-leg rows on that date
      attempted: number;      // upload candidates already pushed — the delivery denominator
      attemptedGclid: number; // of those, carrying a click id
      pending: number;        // candidates not yet attempted (A5 ledger)
      failed: number;
    }
  >();

  for (const r of rows) {
    const date = parseRowDate(r.timestamp);
    if (!date) continue;
    const existing = byDate.get(date) ?? {
      total: 0, attempted: 0, attemptedGclid: 0, pending: 0, failed: 0,
    };
    existing.total++;
    if (isUploadCandidate(r.gclidSource)) {
      if (isA5Pending(r.status)) {
        // A candidate that has NOT been attempted yet. Including it in a
        // DELIVERY rate measures intent rather than outcome.
        existing.pending++;
      } else {
        existing.attempted++;
        if (r.gclidSource === "gclid+ec") existing.attemptedGclid++;
      }
    }
    if (isFailed(r.status)) existing.failed++;
    byDate.set(date, existing);
  }

  const pct = (n: number, total: number) =>
    total > 0 ? parseFloat(((n / total) * 100).toFixed(1)) : 0;

  let trend = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      total: d.total,
      upload_candidates_attempted: d.attempted,
      candidates_pending: d.pending,
      // Denominator is ATTEMPTED upload candidates, not all rows.
      gclid_attach_rate: pct(d.attemptedGclid, d.attempted),
      ec_only_rate: pct(d.attempted - d.attemptedGclid, d.attempted),
      // Forward-leg only. Day-5 failures live in BatchLog and are reported by
      // get_relay_health's day-5 leg.
      error_rate: pct(d.failed, d.total),
    }));

  // Weekly rollup if requested
  if (granularity === "weekly") {
    const weekMap = new Map<string, typeof trend[0][]>();
    for (const row of trend) {
      const weekStart = getWeekStart(row.date);
      const existing = weekMap.get(weekStart) ?? [];
      existing.push(row);
      weekMap.set(weekStart, existing);
    }
    // AUDIT FIX 2026-08-20: this averaged the DAILY PERCENTAGES, which weights
    // every day equally regardless of volume — a day with 1 lead at 100% attach
    // counted the same as a day with 50 leads at 20%. A weekly rate must be the
    // sum of numerators over the sum of denominators, so it is recomputed from
    // the underlying counts rather than averaged from the daily rates.
    trend = Array.from(weekMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, rows]) => {
        const total     = rows.reduce((s, r) => s + r.total, 0);
        const attempted = rows.reduce((s, r) => s + r.upload_candidates_attempted, 0);
        const pending   = rows.reduce((s, r) => s + r.candidates_pending, 0);
        // Recover the numerators from rate × denominator, rounding to the
        // nearest whole event — the daily rows carry rates, not raw counts.
        const attGclid = rows.reduce(
          (s, r) => s + Math.round((r.gclid_attach_rate / 100) * r.upload_candidates_attempted), 0);
        const failed = rows.reduce(
          (s, r) => s + Math.round((r.error_rate / 100) * r.total), 0);
        return {
          date: `week_of_${week}`,
          total,
          upload_candidates_attempted: attempted,
          candidates_pending: pending,
          gclid_attach_rate: pct(attGclid, attempted),
          ec_only_rate: pct(attempted - attGclid, attempted),
          error_rate: pct(failed, total),
        };
      });
  }

  // Trend direction
  const mid = Math.floor(trend.length / 2);
  const firstHalf = trend.slice(0, mid);
  const secondHalf = trend.slice(mid);

  // AUDIT FIX 2026-08-20 (second pass): both the direction verdict and the
  // headline average were computed by AVERAGING DAILY RATES — the same defect
  // corrected in the weekly rollup above, left in place four lines below it.
  // A day with 2 attempted uploads weighed the same as a day with 50.
  //
  // Observed live on the 19–26 Aug window: attempted counts of 2, 7, 2, 12, 6,
  // 18, 6, 3. On 2 events a single lead swings the daily rate 33–50 points, so
  // an average of those rates produced a DEGRADING verdict out of pure noise.
  //
  // Both are now VOLUME-WEIGHTED — sum of numerators over sum of denominators —
  // and the verdict is SUPPRESSED entirely below a minimum sample, because on
  // this data a direction claim is worse than no claim.
  const MIN_ATTEMPTED_FOR_DIRECTION = 30;

  const weighted = (arr: typeof trend) => {
    const att = arr.reduce((s, r) => s + r.upload_candidates_attempted, 0);
    if (att === 0) return null;
    const num = arr.reduce(
      (s, r) => s + Math.round((r.gclid_attach_rate / 100) * r.upload_candidates_attempted), 0);
    return (num / att) * 100;
  };

  const totalAttempted = trend.reduce((s, r) => s + r.upload_candidates_attempted, 0);
  const firstW = weighted(firstHalf);
  const secondW = weighted(secondHalf);

  const trendDirection =
    totalAttempted < MIN_ATTEMPTED_FOR_DIRECTION || firstW === null || secondW === null
      ? `⚠️ NOT ASSESSED — only ${totalAttempted} attempted uploads in this window ` +
        `(need ${MIN_ATTEMPTED_FOR_DIRECTION}). A direction verdict on this sample would be noise.`
      : secondW > firstW + 2
      ? "📈 IMPROVING"
      : secondW < firstW - 2
      ? "📉 DEGRADING"
      : "➡️ STABLE";

  const overall = weighted(trend);

  return {
    period: `${startDate} to ${endDate}`,
    granularity,
    trend_direction: trendDirection,
    // Volume-weighted across the whole window, not a mean of daily rates.
    avg_gclid_attach_rate: overall === null ? "n/a" : `${overall.toFixed(1)}%`,
    total_attempted_uploads: totalAttempted,
    basis:
      "gclid_attach_rate and ec_only_rate are computed over ATTEMPTED upload candidates only — " +
      "rows carrying an identifier that have already been pushed. Non-PPC skips carry no identifier " +
      "and are excluded; A5_PENDING rows are candidates not yet attempted and are excluded from the " +
      "delivery denominator, reported separately as candidates_pending. Day-5 failure rows that relay " +
      "v10.9.8 writes into the Log tab are excluded — they belong to the day-5 leg, reported by " +
      "get_relay_health. THIS IS NOT AN ACCOUNT-WIDE ATTACH RATE: the Log tab is the forward-upgrade " +
      "leg, which is late-funnel and structurally GCLID-poor, and typically ~90% of candidates in any " +
      "window are still pending. An account-wide figure needs per-row identifier state from the " +
      "capture layer.",
    per_day_caveat:
      "Days with fewer than 10 attempted uploads are marked sample_too_small. A 0% or 100% reading " +
      "there is one or two leads, not a signal.",
    trend: trend.map((r) => ({
      ...r,
      sample_too_small: r.upload_candidates_attempted < 10,
    })),
  };
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().substring(0, 10);
}
