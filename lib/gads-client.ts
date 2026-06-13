const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID ?? "4064995850").replace(/-/g, "");
const MCC_ID = (process.env.GOOGLE_ADS_MCC_ID ?? "8910137241").replace(/-/g, "");
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN!;
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET!;
const API_VER = process.env.GOOGLE_ADS_API_VERSION ?? "v23";

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

type Row = Record<string, unknown>;

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc, key) => (acc as Row)?.[key], obj);
}

async function gaql(query: string): Promise<Row[]> {
  const accessToken = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VER}/customers/${CUSTOMER_ID}/googleAds:search`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": DEVELOPER_TOKEN,
      "login-customer-id": MCC_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Google Ads API error (HTTP ${res.status}) URL:${url} MCC:${MCC_ID} CUST:${CUSTOMER_ID} API:${API_VER} Body:${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body) as { results?: Row[] };
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
      metrics.all_conversions
    FROM campaign
    WHERE campaign.status = 'ENABLED'
      AND segments.date BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY segments.date DESC
  `);

  const map = new Map<string, ConversionDayStat>();
  for (const r of rows) {
    const date = String(pick(r, "segments.date") ?? "");
    const action = String(pick(r, "segments.conversionActionName") ?? "");
    const conv = Number(pick(r, "metrics.conversions") ?? 0);
    const key = `${date}||${action}`;
    const existing = map.get(key) ?? { date, conversionAction: action, conversions: 0, conversionValue: 0 };
    existing.conversions += conv;
    map.set(key, existing);
  }

  let results = Array.from(map.values());
  if (actionNames && actionNames.length > 0) {
    results = results.filter((r) =>
      actionNames.some((n) => r.conversionAction.toLowerCase().includes(n.toLowerCase()))
    );
  }
  return results;
}

export async function getConversionTotals(
  startDate: string,
  endDate: string
): Promise<{ conversionAction: string; total: number }[]> {
  const rows = await getConversionsByDay(startDate, endDate);
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.conversionAction, (map.get(r.conversionAction) ?? 0) + r.conversions);
  }
  return Array.from(map.entries())
    .map(([conversionAction, total]) => ({ conversionAction, total }))
    .sort((a, b) => b.total - a.total);
}

export async function testGadsConnection(): Promise<{ ok: boolean; detail: string; url?: string }> {
  try {
    const token = await getAccessToken();
    const url = `https://googleads.googleapis.com/${API_VER}/customers/${CUSTOMER_ID}/googleAds:search`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": DEVELOPER_TOKEN,
        "login-customer-id": MCC_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = 'ENABLED' LIMIT 1" }),
    });
    const body = await res.text();
    return {
      ok: res.ok,
      url,
      detail: `HTTP ${res.status} | MCC:${MCC_ID} | CUST:${CUSTOMER_ID} | API:${API_VER} | Body: ${body.slice(0, 300)}`,
    };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}
