import { readRelayLogByDateRange } from "../sheets-client";
import { isA5Pending, isTrueSkip, isFailed } from "../status-classify";

export async function getCoverageBySource(params: {
  startDate: string;
  endDate: string;
}) {
  const { startDate, endDate } = params;
  const rows = await readRelayLogByDateRange(startDate, endDate);

  if (rows.length === 0) {
    return { error: "No rows found for period", startDate, endDate };
  }

  // Group by stage (which maps to lead source/type)
  const byStage = new Map<
    string,
    { total: number; success: number; ecOnly: number; noGclid: number; skipped: number; failed: number; a5Pending: number }
  >();

  for (const r of rows) {
    const stage = r.newStage || "UNKNOWN";
    const existing = byStage.get(stage) ?? {
      total: 0, success: 0, ecOnly: 0, noGclid: 0, skipped: 0, failed: 0, a5Pending: 0,
    };
    existing.total++;
    if (r.status === "SUCCESS") existing.success++;
    else if (r.status === "SUCCESS_EC_ONLY") existing.ecOnly++;
    else if (isA5Pending(r.status)) existing.a5Pending++;
    else if (isTrueSkip(r.status)) existing.skipped++;
    else if (isFailed(r.status)) existing.failed++;
    if (r.gclidSource === "none" || r.gclidSource === "ec_only") existing.noGclid++;
    byStage.set(stage, existing);
  }

  const pct = (n: number, total: number) =>
    total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";

  const breakdown = Array.from(byStage.entries())
    .map(([stage, counts]) => {
      // A stage with zero SUCCESS/EC_ONLY rows is only a real coverage hole
      // if something other than "still waiting for day-5" explains it. If
      // every non-reaching row is A5-pending, this stage just hasn't cleared
      // the delay window yet — that's healthy, not a hole.
      const reaching = counts.success + counts.ecOnly;
      const unexplainedGap = counts.total - reaching - counts.a5Pending;
      return {
        stage,
        total: counts.total,
        reaching_gads: reaching,
        success: counts.success,
        ec_only: counts.ecOnly,
        no_gclid: counts.noGclid,
        skipped: counts.skipped,
        failed: counts.failed,
        a5_pending: counts.a5Pending,
        coverage_rate: pct(reaching, counts.total),
        gclid_rate: pct(counts.total - counts.noGclid, counts.total),
        flag: counts.total > 0 && reaching === 0 && unexplainedGap > 0
          ? "🔴 ZERO_COVERAGE"
          : counts.total > 0 && reaching === 0 && counts.a5Pending > 0
          ? "⏳ AWAITING_DAY5"
          : counts.noGclid / counts.total > 0.5
          ? "⚠️ HIGH_EC_ONLY"
          : "✅ OK",
      };
    })
    .sort((a, b) => b.total - a.total);

  const coverageHoles = breakdown.filter((b) => b.flag === "🔴 ZERO_COVERAGE");

  return {
    period: `${startDate} to ${endDate}`,
    total_rows: rows.length,
    coverage_by_stage: breakdown,
    coverage_holes: coverageHoles.map((b) => b.stage),
    summary: coverageHoles.length === 0
      ? "✅ All sources reaching Google Ads"
      : `🔴 ${coverageHoles.length} source(s) with zero coverage: ${coverageHoles.map((b) => b.stage).join(", ")}`,
  };
}
