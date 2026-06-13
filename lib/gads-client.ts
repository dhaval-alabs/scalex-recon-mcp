const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID ?? "4064995850";
const MCC_ID = process.env.GOOGLE_ADS_MCC_ID ?? "8910137241";
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN!;
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET!;
const GADS_API_VERSION = "v19";

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gaql(query: string): Promise<any[]> {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://googleads.googleapis.com/${GADS_API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "developer-token": DEVELOPER_TOKEN,
        "login-customer-id": MCC_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Google Ads API error: ${JSON.stringify(data.error)}`);
  return data.results ?? [];
}

export interface ConversionDayStat {
  date: string;
  conversionAction: string;
  conversions: number;
  conversionValue: number;
}

export async function getConversionsByDay(
  startDate: string,
  endDate: string,
  actionNames?: string[]
): Promise<ConversionDayStat[]> {
  const rows = await gaql(`
    SELECT
      segments.date,
      segments.conversion_action_name,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status = 'ENABLED'
    ORDER BY segments.date DESC
  `);

  const results: ConversionDayStat[] = rows.map((r: any) => ({
    date: r.segments?.date ?? "",
    conversionAction: r.segments?.conversionActionName ?? "",
    conversions: parseFloat(r.metrics?.conversions ?? "0"),
    conversionValue: parseFloat(r.metrics?.conversionsValue ?? "0"),
  }));

  if (actionNames && actionNames.length > 0) {
    return results.filter((r) =>
      actionNames.some((n) => r.conversionAction.toLowerCase().includes(n.toLowerCase()))
    );
  }
  return results;
}

export async function getConversionTotals(
  startDate: string,
  endDate: string
): Promise<{ conversionAction: string; total: number; value: number }[]> {
  const rows = await getConversionsByDay(startDate, endDate);
  const map = new Map<string, { total: number; value: number }>();
  for (const r of rows) {
    const existing = map.get(r.conversionAction) ?? { total: 0, value: 0 };
    map.set(r.conversionAction, {
      total: existing.total + r.conversions,
      value: existing.value + r.conversionValue,
    });
  }
  return Array.from(map.entries())
    .map(([conversionAction, stats]) => ({ conversionAction, ...stats }))
    .sort((a, b) => b.total - a.total);
}
