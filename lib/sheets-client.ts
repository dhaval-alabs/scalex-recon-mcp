import { google } from "googleapis";
import { JWT } from "google-auth-library";

const RELAY_LOG_SPREADSHEET_ID = process.env.RELAY_LOG_SPREADSHEET_ID!;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

function getAuthClient(): JWT {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");
  const credentials = JSON.parse(raw);
  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });
}

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuthClient() });
}

export interface RelayLogRow {
  timestamp: string;
  prospectId: string;
  email: string;
  stage: string;
  gclid: string;
  gclidSource: string;
  status: string;
  conversionAction: string;
  conversionValue: number;
  batchId: string;
}

export interface BatchLogRow {
  timestamp: string;
  batchId: string;
  rowsSent: number;
  rowsAccepted: number;
  status: string;
}

// Read raw rows from the Log tab
export async function readRelayLog(limit = 500): Promise<RelayLogRow[]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: RELAY_LOG_SPREADSHEET_ID,
    range: `Log!A2:Z${limit + 1}`,
  });

  const rows = response.data.values ?? [];
  return rows.map((r) => ({
    timestamp: r[0] ?? "",
    prospectId: r[1] ?? "",
    email: r[2] ?? "",
    stage: r[3] ?? "",
    gclid: r[4] ?? "",
    gclidSource: r[5] ?? "",
    status: r[6] ?? "",
    conversionAction: r[7] ?? "",
    conversionValue: parseFloat(r[8] ?? "0"),
    batchId: r[9] ?? "",
  }));
}

// Read rows filtered by date range
export async function readRelayLogByDateRange(
  startDate: string,
  endDate: string
): Promise<RelayLogRow[]> {
  const all = await readRelayLog(5000);
  return all.filter((r) => {
    if (!r.timestamp) return false;
    const d = r.timestamp.substring(0, 10);
    return d >= startDate && d <= endDate;
  });
}

// Read BatchLog tab
export async function readBatchLog(limit = 100): Promise<BatchLogRow[]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: RELAY_LOG_SPREADSHEET_ID,
    range: `BatchLog!A2:Z${limit + 1}`,
  });

  const rows = response.data.values ?? [];
  return rows.map((r) => ({
    timestamp: r[0] ?? "",
    batchId: r[1] ?? "",
    rowsSent: parseInt(r[2] ?? "0"),
    rowsAccepted: parseInt(r[3] ?? "0"),
    status: r[4] ?? "",
  }));
}
