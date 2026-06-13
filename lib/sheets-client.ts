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

// Actual relay log columns (21 columns, A-U):
// A=Timestamp, B=Status, C=OldStage, D=NewStage, E=GCLID, F=Value,
// G=ProspectID, H=Name, I=Email, J=Phone, K=Source, L=Medium,
// M=Campaign, N=PageURL, O=LeadScore, P=EngagementScore,
// Q=FBClickID, R=HashedEmail, S=HashedPhone, T=GCLIDSource, U=Message

export interface RelayLogRow {
  timestamp: string;
  status: string;
  oldStage: string;
  newStage: string;
  gclid: string;
  value: number;
  prospectId: string;
  name: string;
  email: string;
  phone: string;
  source: string;
  medium: string;
  campaign: string;
  gclidSource: string; // col T: 'gclid+ec', 'ec_only', 'none'
  message: string;    // col U
}

export interface BatchLogRow {
  timestamp: string;
  batchId: string;
  rowsSent: number;
  rowsAccepted: number;
  status: string;
}

// Parse M/D/YYYY HH:MM:SS or YYYY-MM-DD timestamps to YYYY-MM-DD
function parseRowDate(timestamp: string): string {
  if (!timestamp) return "";
  // Handle M/D/YYYY HH:MM:SS format (Google Sheets default)
  const mdyMatch = timestamp.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Handle YYYY-MM-DD format
  return timestamp.substring(0, 10);
}

// Read raw rows from the Log tab
export async function readRelayLog(limit = 10000): Promise<RelayLogRow[]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: RELAY_LOG_SPREADSHEET_ID,
    range: `Log!A2:U${limit + 1}`,
  });

  const rows = response.data.values ?? [];
  return rows.map((r) => ({
    timestamp:   r[0]  ?? "",
    status:      r[1]  ?? "",
    oldStage:    r[2]  ?? "",
    newStage:    r[3]  ?? "",
    gclid:       r[4]  ?? "",
    value:       parseFloat(r[5] ?? "0"),
    prospectId:  r[6]  ?? "",
    name:        r[7]  ?? "",
    email:       r[8]  ?? "",
    phone:       r[9]  ?? "",
    source:      r[10] ?? "",
    medium:      r[11] ?? "",
    campaign:    r[12] ?? "",
    gclidSource: r[19] ?? "",  // col T
    message:     r[20] ?? "",  // col U
  }));
}

// Read rows filtered by date range
export async function readRelayLogByDateRange(
  startDate: string,
  endDate: string
): Promise<RelayLogRow[]> {
  const all = await readRelayLog(10000);
  return all.filter((r) => {
    if (!r.timestamp) return false;
    const d = parseRowDate(r.timestamp);
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
