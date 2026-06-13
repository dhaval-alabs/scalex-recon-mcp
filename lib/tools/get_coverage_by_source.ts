import { readRelayLogByDateRange } from "../sheets-client";

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
    { total: number; success: number; ecOnly: number; noGclid: number; skipped: number; failed: number }
  >();

  for (const r of rows) {
    const stage = r.stage || "UNKNOWN";
    const existing = byStage.get(stage) ?? {
      total: 0, success: 0, ecOnly: 0, noGclid: 0, skipped: 0, failed: 0,
    };
    existing.total++;
    if (r.status === "SUCCESS") existing.success++;
    else if (r.status === "SUCCESS_EC_ONLY") existing.ecOnly++;
    else if (r.status?.includes("SKIP")) existing.skipped++;
    else if (r.status?.includes("FAIL")) existing.failed++;
    if (r.gclidSource === "none") existing.noGclid++;
    byStage.set(stage, existing);
  }

  const pct = (n: number, total: number) =>
    total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";

  const breakdown = Array.from(byStage.entries())
    .map(([stage, counts]) => ({
      stage,
      total: counts.total,
      reaching_gads: counts.success + counts.ecOnly,
      success: counts.success,
      ec_only: counts.ecOnly,
      no_gclid: counts.noGclid,
      skipped: counts.skipped,
      failed: counts.failed,
      coverage_rate: pct(counts.success + counts.ecOnly, counts.total),
      gclid_rate: pct(counts.total - counts.noGclid, counts.total),
      flag: counts.total > 0 && (counts.success + counts.ecOnly) === 0
        ? "🔴 ZERO_COVERAGE"
        : counts.noGclid / counts.total > 0.5
        ? "⚠️ HIGH_EC_ONLY"
        : "✅ OK",
    }))
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
