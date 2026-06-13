import { NextRequest, NextResponse } from "next/server";
import { testGadsConnection } from "../../../lib/gads-client";
import { reconcileRelayVsGads } from "../../../lib/tools/reconcile_relay_vs_gads";
import { getRelayHealth } from "../../../lib/tools/get_relay_health";
import { verifyBatchLanded } from "../../../lib/tools/verify_batch_landed";
import { getCoverageBySource } from "../../../lib/tools/get_coverage_by_source";
import { getSignalQualityTrend } from "../../../lib/tools/get_signal_quality_trend";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const tools = [
  {
    name: "reconcile_relay_vs_gads",
    description: "Cross-verify relay log vs Google Ads: how many leads did the relay attempt to send vs how many Google Ads actually received. Returns daily diff table with gap % and health status.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        endDate: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "get_relay_health",
    description: "Snapshot of relay health: status breakdown (SUCCESS/EC_ONLY/FAIL/SKIP), GCLID source distribution, attach rate, EC-only rate, and error rate for the last N days.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to look back. Default 7.", default: 7 },
      },
    },
  },
  {
    name: "verify_batch_landed",
    description: "Verify whether relay batches of restatements landed in Google Ads. Checks BatchLog against Google Ads conversion counts on the batch date.",
    inputSchema: {
      type: "object",
      properties: {
        batchId: { type: "string", description: "Specific batch ID to verify. Omit for last N batches." },
        lastN: { type: "number", description: "Number of recent batches to check. Default 5.", default: 5 },
      },
    },
  },
  {
    name: "get_coverage_by_source",
    description: "Shows which lead sources (stages) are reaching Google Ads and which have zero coverage. Flags ZERO_COVERAGE holes and HIGH_EC_ONLY sources.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start date YYYY-MM-DD" },
        endDate: { type: "string", description: "End date YYYY-MM-DD" },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "get_signal_quality_trend",
    description: "Trend of signal quality over time: GCLID attach rate, EC-only rate, error rate. Shows if signal quality is improving or degrading.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Lookback window in days. Default 30.", default: 30 },
        granularity: { type: "string", enum: ["daily", "weekly"], description: "daily or weekly rollup. Default daily.", default: "daily" },
      },
    },
  },
  {
    name: "test_gads_connection",
    description: "Debug tool — tests OAuth and one GAQL call to verify Google Ads API connectivity.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "reconcile_relay_vs_gads":
      return await reconcileRelayVsGads(args as { startDate: string; endDate: string });
    case "get_relay_health":
      return await getRelayHealth(args as { days?: number });
    case "verify_batch_landed":
      return await verifyBatchLanded(args as { batchId?: string; lastN?: number });
    case "get_coverage_by_source":
      return await getCoverageBySource(args as { startDate: string; endDate: string });
    case "get_signal_quality_trend":
      return await getSignalQualityTrend(args as { days?: number; granularity?: "daily" | "weekly" });
    case "test_gads_connection":
      return await testGadsConnection();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { method, id, params } = body;

    if (method === "initialize") {
      return NextResponse.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "scalex-recon-mcp", version: "1.0.0" },
        },
      });
    }

    if (method === "notifications/initialized") {
      return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === "tools/list") {
      return NextResponse.json({ jsonrpc: "2.0", id, result: { tools } }, { headers: CORS_HEADERS });
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
      const result = await callTool(name, args ?? {});
      return NextResponse.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    }

    return NextResponse.json(
      { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } },
      { status: 404, headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error("[ScaleX Recon MCP] Error:", err);
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    status: "ScaleX Reconciliation MCP running",
    version: "1.0.0",
    tools: tools.map((t) => t.name),
  }, { headers: CORS_HEADERS });
}
