#!/usr/bin/env node
/**
 * TerminAI MCP Bridge PoC
 *
 * Minimal MCP server that registers tools and logs EVERYTHING it receives
 * from AI CLI hosts (Claude Code, Codex CLI, Gemini CLI).
 *
 * Purpose: Determine what data an MCP server actually has access to.
 * All received data is written to /tmp/terminai-mcp-poc.json for inspection.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFileSync, writeFileSync } from "node:fs";

const LOG_PATH = "/tmp/terminai-mcp-poc.json";
const LOG_RAW_PATH = "/tmp/terminai-mcp-poc-raw.log";

// Initialize log file
writeFileSync(LOG_PATH, "[\n");

let entryCount = 0;

function logEntry(type: string, data: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    data,
    _entryIndex: entryCount++,
  };

  // Append to JSON array file
  const prefix = entryCount === 1 ? "" : ",\n";
  appendFileSync(LOG_PATH, `${prefix}${JSON.stringify(entry, null, 2)}`);

  // Also log to raw file for easy tailing
  appendFileSync(LOG_RAW_PATH, `[${entry.timestamp}] ${type}: ${JSON.stringify(data)}\n`);

  console.error(`[terminai-mcp] ${type}:`, JSON.stringify(data).slice(0, 200));
}

// Create MCP server
const server = new McpServer(
  {
    name: "terminai-bridge",
    version: "0.1.0",
  },
  {
    capabilities: {
      logging: {},
    },
  },
);

// Tool 1: report_metrics - accepts arbitrary JSON, logs everything
server.tool(
  "report_metrics",
  "Report any metrics, status, or telemetry data to TerminAI HUD. " +
    "Call this with any available session data: model name, token counts, " +
    "cost, rate limits, context window usage, active tools, etc.",
  {
    model: z.string().optional().describe("Current AI model name"),
    tokens_in: z.number().optional().describe("Input token count"),
    tokens_out: z.number().optional().describe("Output token count"),
    cost_usd: z.number().optional().describe("Session cost in USD"),
    context_used: z.number().optional().describe("Context tokens used"),
    context_total: z.number().optional().describe("Total context window size"),
    rate_limit_percent: z.number().optional().describe("Rate limit usage percentage"),
    status: z.string().optional().describe("Current session status"),
    extra: z.record(z.unknown()).optional().describe("Any additional data"),
  },
  async (args) => {
    logEntry("tool_call:report_metrics", {
      arguments: args,
      // Log the raw arguments object to see what keys the AI actually sends
      argumentKeys: Object.keys(args),
      argumentValues: args,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ received: true, logged: true }),
        },
      ],
    };
  },
);

// Tool 2: get_status - returns static response, logs what context the server has
server.tool(
  "get_status",
  "Get TerminAI bridge status. Returns connection info.",
  {},
  async (_args, extra) => {
    logEntry("tool_call:get_status", {
      arguments: _args,
      // Log everything available in the extra/context object
      extraKeys: extra ? Object.keys(extra) : [],
      extra: extra,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "connected",
            bridge: "terminai-mcp-bridge",
            version: "0.1.0",
            purpose: "PoC - logging all received data",
            log_path: LOG_PATH,
          }),
        },
      ],
    };
  },
);

// Tool 3: ping - simplest possible tool to test MCP connectivity
server.tool("ping", "Ping the TerminAI bridge", {}, async () => {
  logEntry("tool_call:ping", { pong: true });
  return {
    content: [{ type: "text" as const, text: "pong" }],
  };
});

// Start server
async function main(): Promise<void> {
  logEntry("server_start", {
    pid: process.pid,
    argv: process.argv,
    env_keys: Object.keys(process.env).filter(
      (k) =>
        k.startsWith("MCP") ||
        k.startsWith("CLAUDE") ||
        k.startsWith("CODEX") ||
        k.startsWith("GEMINI") ||
        k.startsWith("ANTHROPIC") ||
        k.startsWith("OPENAI") ||
        k === "HOME" ||
        k === "USER" ||
        k === "SHELL",
    ),
    env_mcp: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith("MCP")),
    ),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[terminai-mcp] Bridge PoC running on stdio");
  console.error(`[terminai-mcp] Logging to ${LOG_PATH}`);
}

main().catch((error) => {
  console.error("[terminai-mcp] Fatal error:", error);
  process.exit(1);
});
