/**
 * claude-orchestrator MCP Server
 *
 * Central orchestration plugin providing 21 tools across 6 groups:
 * reminders, workflows, skill learning, session context, multi-model dispatch, agent teams
 */

// CRITICAL: Redirect console.log to stderr — stdout is reserved for MCP JSON-RPC
const _log = console.log;
console.log = (...args: unknown[]) => {
  console.error("[orchestrator]", ...args);
};

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolDef } from "./types";
import { ensureStorageDir } from "./storage";
import { contextTools } from "./tools/context";
import { reminderTools } from "./tools/reminders";
import { workflowTools } from "./tools/workflow";
import { learningTools } from "./tools/learning";
import { dispatchTools, recoverOrphanedTasks } from "./tools/dispatch";
import { teamTools } from "./tools/teams";

// ── Collect all tools ──
const allTools: ToolDef[] = [
  ...contextTools,
  ...reminderTools,
  ...workflowTools,
  ...learningTools,
  ...dispatchTools,
  ...teamTools,
];

// ── Create MCP server ──
const server = new Server(
  { name: "claude-orchestrator", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── tools/list handler ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// ── tools/call handler ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = allTools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler((request.params.arguments as Record<string, unknown>) || {});
  } catch (error) {
    console.error(`Tool "${request.params.name}" error:`, error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Graceful shutdown ──
function cleanup() {
  console.error("Shutting down");
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// ── Start ──
async function main() {
  // Ensure storage directory
  ensureStorageDir();

  // Recover orphaned dispatch tasks
  try {
    recoverOrphanedTasks();
  } catch (e) {
    console.error("Orphan recovery error:", e);
  }

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`claude-orchestrator started (${allTools.length} tools)`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(0); // Exit 0 to avoid Windows Terminal tab accumulation
});
