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
  /** Which Google metric produced `conversions`. Never read a number from this
   *  module without it — `metrics.conversions` and
   *  `all_conversions_by_conversion_date` disagree by design and two tools
   *  reporting different figures for "conversions" is what made an entire
   *  week's reconciliation unreadable. */
  metric: string;
  /** Which date `date` refers to. click_date and conversion_date are different
   *  questions; an unlabelled date segment is not interpretable. */
  axis: "conversion_date" | "click_date";
}

export const METRIC_LABEL = "all_conversions_by_conversion_date";
export const AXIS_LABEL = "conversion_date" as const;

// ─────────────────────────────────────────────────────────────────────────
// DATE AXIS — this is the single most important thing about this function.
//
// Google Ads files an uploaded offline conversion under the date of the
// ORIGINAL CLICK, not the date we uploaded it. `metrics.conversions` with
// `segments.date` is therefore CLICK-DATED, which made every relay-vs-Google
// comparison structurally invalid: our relay rows are keyed on the stage-change
// moment, Google's were keyed on a click that could be weeks earlier.
// Confirmed with hard dates: an enrolment pushed 2026-07-22 filed under click
// date 2026-07-10; one pushed 07-13 filed under 06-30.
//
// FIX: select a *_by_conversion_date metric. When one is selected alongside
// `segments.date`, `segments.date` changes meaning to the CONVERSION date —
// which for offline imports is the `conversion_date_time` we upload. That
// aligns Google's axis with our own dates in a single query.
//
// `all_conversions_by_conversion_date` (not `conversions_by_conversion_date`)
// because imported offline conversions frequently land in all_conversions —
// Secondary actions are excluded from `metrics.conversions` entirely.
//
// Google does NOT support conversions by UPLOAD date at all. That avenue is
// closed; do not go looking for it again.
//
// KNOWN HAZARD: on some resources this field is silently omitted — no error,
// no value. A missing field would read as zero and look like a delivery
// failure. Rather than trusting it, this function DETECTS the omission and
// throws (see assertion below), so a silent omission becomes a loud failure.
//
// Also note: FROM customer, not FROM campaign. `FROM campaign` requires
// `campaign.status = 'ENABLED'` or it drops rows, which silently discarded
// conversions correctly attributed to since-paused campaigns. This function
// aggregates account-wide by action name, so it never needed campaign rows.
// ─────────────────────────────────────────────────────────────────────────

const BY_CONV_DATE_FIELD = "metrics.allConversionsByConversionDate";

export async function getConversionsByDay(
  startDate: string,
  endDate: string,
  actionNames?: string[]
): Promise<ConversionDayStat[]> {
  const rows = await gaql(`
    SELECT
      segments.date,
      segments.conversion_action_name,
      metrics.all_conversions_by_conversion_date,
      metrics.all_conversions_value_by_conversion_date
    FROM customer
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY segments.date DESC
  `);

  // Detect silent field omission: if rows came back but NONE of them carry the
  // by-conversion-date field, the API dropped it and every figure below would
  // be a false zero. Fail loudly instead.
  if (rows.length > 0) {
    const present = rows.filter((r) => pick(r, BY_CONV_DATE_FIELD) !== undefined).length;
    if (present === 0) {
      throw new Error(
        `Google Ads returned ${rows.length} rows but omitted ${BY_CONV_DATE_FIELD} on all of them ` +
          `(API ${API_VER}). This field is silently unsupported on some resources — the numbers would ` +
          `have read as zeros. Validate the query in Google's Query Validator for this API version ` +
          `before trusting any result from this tool.`
      );
    }
  }

  const map = new Map<string, ConversionDayStat>();
  for (const r of rows) {
    const date = String(pick(r, "segments.date") ?? "");
    const action = String(pick(r, "segments.conversionActionName") ?? "");
    const conv = Number(pick(r, BY_CONV_DATE_FIELD) ?? 0);
    const val = Number(pick(r, "metrics.allConversionsValueByConversionDate") ?? 0);
    const key = `${date}||${action}`;
    const existing =
      map.get(key) ?? {
        date,
        conversionAction: action,
        conversions: 0,
        conversionValue: 0,
        metric: METRIC_LABEL,
        axis: AXIS_LABEL,
      };
    existing.conversions += conv;
    existing.conversionValue += val;
    map.set(key, existing);
  }

  let results = Array.from(map.values());
  if (actionNames && actionNames.length > 0) {
    const before = results.length;
    results = results.filter((r) =>
      actionNames.some((n) => r.conversionAction.toLowerCase().includes(n.toLowerCase()))
    );

    // ── WHY THERE IS NO THROW HERE ───────────────────────────────────────
    // A silent-zero guard belongs where a zero can masquerade as no-data.
    // That is true in alabs-ga-mcp, which reads `metrics.conversions`: an
    // action excluded from a campaign's bid goals returns 0 there while
    // recording real volume, and the two are indistinguishable.
    //
    // It is NOT true here. This module reads
    // all_conversions_by_conversion_date, which counts non-biddable actions
    // too, so a zero is a zero.
    //
    // The remaining ambiguity is a filter matching nothing. That is left to
    // the caller deliberately: both callers pass ["sclx"] over short windows
    // where genuinely zero _sclx conversions is a correct answer, and
    // verify_batch_landed already labels its result `gads_volume_present`
    // with an explicit note that it cannot confirm a specific batch landed.
    // Throwing would convert correct behaviour into a crash.
    //
    // What IS enforced: every row leaving this module carries `metric` and
    // `axis`, so no number can be compared against another tool's number
    // without both being identified first.
    if (before > 0 && results.length === 0) {
      // Intentionally not an error. Recorded here so the condition is visible
      // in logs rather than inferred from an empty array.
      console.warn(
        `[gads-client] actionNames filter [${actionNames.join(", ")}] matched 0 of ${before} ` +
          `actions for ${startDate}..${endDate}. Metric=${METRIC_LABEL}. This is a real zero for ` +
          `these action names in this window, not a failed query.`
      );
    }
  }
  return results;
}

export async function getConversionTotals(
  startDate: string,
  endDate: string
): Promise<{ conversionAction: string; total: number; metric: string; axis: string }[]> {
  const rows = await getConversionsByDay(startDate, endDate);
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.conversionAction, (map.get(r.conversionAction) ?? 0) + r.conversions);
  }
  // Every number leaving this module carries its metric and axis. A bare
  // `total` is not reportable — it cannot be reconciled against any other
  // tool without knowing which of Google's several conversion metrics it is.
  return Array.from(map.entries())
    .map(([conversionAction, total]) => ({
      conversionAction,
      total,
      metric: METRIC_LABEL,
      axis: AXIS_LABEL,
    }))
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
