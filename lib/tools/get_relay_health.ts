import { readRelayLogByDateRange } from "../sheets-client";

export async function getRelayHealth(params: { days?: number }) {
  const days = params.days ?? 7;
  const endDate = new Date().toISOString().substring(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);

  const rows = await readRelayLogByDateRange(startDate, endDate);

  if (rows.length === 0) {
    return { error: "No relay log rows found for period", startDate, endDate };
  }

  // Status breakdown
  const statusCounts = new Map<string, number>();
  for (const r of rows) {
    const s = r.status || "UNKNOWN";
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }

  // GCLID source breakdown — actual values: 'gclid+ec', 'ec_only', 'none'
  const gclidSourceCounts = new Map<string, number>();
  for (const r of rows) {
    const s = r.gclidSource || "none";
    gclidSourceCounts.set(s, (gclidSourceCounts.get(s) ?? 0) + 1);
  }

  const total = rows.length;
  const success = statusCounts.get("SUCCESS") ?? 0;
  const ecOnly = statusCounts.get("SUCCESS_EC_ONLY") ?? 0;
  const failed = Array.from(statusCounts.entries())
    .filter(([k]) => k.includes("FAIL"))
    .reduce((s, [, v]) => s + v, 0);
  const skipped = Array.from(statusCounts.entries())
    .filter(([k]) => k.includes("SKIP"))
    .reduce((s, [, v]) => s + v, 0);

  // gclid+ec = has GCLID (from LSQ or cookie), ec_only = no GCLID
  const gclidAttached = gclidSourceCounts.get("gclid+ec") ?? 0;
  const gclidNone = (gclidSourceCounts.get("ec_only") ?? 0) + (gclidSourceCounts.get("none") ?? 0);

  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  return {
    period: `Last ${days} days (${startDate} to ${endDate})`,
    total_rows: total,
    status_breakdown: {
      SUCCESS: { count: success, pct: pct(success) },
      SUCCESS_EC_ONLY: { count: ecOnly, pct: pct(ecOnly) },
      FAILED: { count: failed, pct: pct(failed) },
      SKIPPED: { count: skipped, pct: pct(skipped) },
    },
    gclid_source_breakdown: Object.fromEntries(
      Array.from(gclidSourceCounts.entries()).map(([k, v]) => [
        k, { count: v, pct: pct(v) }
      ])
    ),
    rates: {
      gclid_attach_rate: pct(gclidAttached),
      ec_only_rate: pct(gclidNone),
      error_rate: pct(failed),
      skip_rate: pct(skipped),
    },
    health: failed / total < 0.05 && gclidNone / total < 0.3
      ? "✅ HEALTHY"
      : "⚠️ NEEDS_REVIEW",
  };
}
