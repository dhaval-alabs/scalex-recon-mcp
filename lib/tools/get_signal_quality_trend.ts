import { readRelayLogByDateRange } from "../sheets-client";

export async function getSignalQualityTrend(params: {
  days?: number;
  granularity?: "daily" | "weekly";
}) {
  const { days = 30, granularity = "daily" } = params;
  const endDate = new Date().toISOString().substring(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().substring(0, 10);

  const rows = await readRelayLogByDateRange(startDate, endDate);
  if (rows.length === 0) return { error: "No rows found for period" };

  // Group by date
  const byDate = new Map<
    string,
    { total: number; gclidLsq: number; gclidCookie: number; gclidNone: number; ecOnly: number; failed: number }
  >();

  for (const r of rows) {
    const date = r.timestamp.substring(0, 10);
    const existing = byDate.get(date) ?? {
      total: 0, gclidLsq: 0, gclidCookie: 0, gclidNone: 0, ecOnly: 0, failed: 0,
    };
    existing.total++;
    if (r.gclidSource === "lsq") existing.gclidLsq++;
    else if (r.gclidSource === "gcl_aw") existing.gclidCookie++;
    else existing.gclidNone++;
    if (r.status === "SUCCESS_EC_ONLY") existing.ecOnly++;
    if (r.status?.includes("FAIL")) existing.failed++;
    byDate.set(date, existing);
  }

  const pct = (n: number, total: number) =>
    total > 0 ? parseFloat(((n / total) * 100).toFixed(1)) : 0;

  let trend = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      total: d.total,
      gclid_attach_rate: pct(d.gclidLsq + d.gclidCookie, d.total),
      lsq_gclid_rate: pct(d.gclidLsq, d.total),
      cookie_recovery_rate: pct(d.gclidCookie, d.total),
      ec_only_rate: pct(d.gclidNone, d.total),
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
    trend = Array.from(weekMap.entries()).map(([week, rows]) => {
      const total = rows.reduce((s, r) => s + r.total, 0);
      const avg = (key: keyof typeof rows[0]) =>
        parseFloat((rows.reduce((s, r) => s + (r[key] as number), 0) / rows.length).toFixed(1));
      return {
        date: `week_of_${week}`,
        total,
        gclid_attach_rate: avg("gclid_attach_rate"),
        lsq_gclid_rate: avg("lsq_gclid_rate"),
        cookie_recovery_rate: avg("cookie_recovery_rate"),
        ec_only_rate: avg("ec_only_rate"),
        error_rate: avg("error_rate"),
      };
    });
  }

  // Compare first half vs second half for trend direction
  const mid = Math.floor(trend.length / 2);
  const firstHalf = trend.slice(0, mid);
  const secondHalf = trend.slice(mid);
  const avgAttach = (arr: typeof trend) =>
    arr.reduce((s, r) => s + r.gclid_attach_rate, 0) / Math.max(arr.length, 1);

  const trendDirection =
    avgAttach(secondHalf) > avgAttach(firstHalf) + 2
      ? "📈 IMPROVING"
      : avgAttach(secondHalf) < avgAttach(firstHalf) - 2
      ? "📉 DEGRADING"
      : "➡️ STABLE";

  return {
    period: `${startDate} to ${endDate}`,
    granularity,
    trend_direction: trendDirection,
    avg_gclid_attach_rate: `${(trend.reduce((s, r) => s + r.gclid_attach_rate, 0) / trend.length).toFixed(1)}%`,
    trend,
  };
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().substring(0, 10);
}
