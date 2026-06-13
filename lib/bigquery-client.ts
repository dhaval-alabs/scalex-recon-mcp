import { BigQuery } from "@google-cloud/bigquery";

const PROJECT_ID = "scalex-version1";
const DATASET = "scalex360_v1";

function getBQClient(): BigQuery {
  const raw = process.env.BQ_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("BQ_SERVICE_ACCOUNT_JSON env var is not set");
  const credentials = JSON.parse(raw);
  return new BigQuery({
    projectId: PROJECT_ID,
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
  });
}

export async function runBQQuery(query: string): Promise<any[]> {
  const bq = getBQClient();
  const [rows] = await bq.query({ query, location: "US" });
  return rows;
}

// Get daily ads spend from Google + Meta
export async function getAdSpendByDay(
  startDate: string,
  endDate: string
): Promise<{ date: string; channel: string; spend: number; conversions: number }[]> {
  const query = `
    SELECT
      CAST(segments_date AS STRING) AS date,
      'Google Ads' AS channel,
      SUM(cost_micros) / 1e6 AS spend,
      SUM(conversions) AS conversions
    FROM \`${PROJECT_ID}.${DATASET}.ads_google_campaign_daily_v2\`
    WHERE segments_date BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY date, channel

    UNION ALL

    SELECT
      CAST(date AS STRING) AS date,
      'Meta Ads' AS channel,
      SUM(spend) AS spend,
      SUM(CAST(JSON_VALUE(conversions_json, '$.value') AS FLOAT64)) AS conversions
    FROM \`${PROJECT_ID}.${DATASET}.ads_meta_campaign_daily_v2\`
    WHERE date BETWEEN '${startDate}' AND '${endDate}'
    GROUP BY date, channel

    ORDER BY date DESC
  `;
  return await runBQQuery(query);
}
