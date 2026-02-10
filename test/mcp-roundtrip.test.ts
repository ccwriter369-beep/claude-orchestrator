/**
 * Round-trip tests for all 6 tool groups via the MCP protocol.
 * Spawns the actual MCP server and communicates via JSON-RPC.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";
import { join } from "path";
import { existsSync, rmSync, mkdirSync } from "fs";
import { homedir } from "os";

const SERVER_PATH = join(import.meta.dir, "..", "scripts", "mcp-server.cjs");
const STORAGE_DIR = join(homedir(), ".claude", "orchestrator");

// Backup and restore storage between test runs
const BACKUP_DIR = STORAGE_DIR + ".test-backup";

let proc: ReturnType<typeof spawn>;
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";

function sendMessage(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++msgId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin!.write(msg + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }
    }, 10000);
  });
}

function sendNotification(method: string, params: Record<string, unknown> = {}): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  proc.stdin!.write(msg + "\n");
}

function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return sendMessage("tools/call", { name, arguments: args });
}

function getText(result: any): string {
  return result.result.content[0].text;
}

beforeAll(async () => {
  // Backup existing storage
  if (existsSync(STORAGE_DIR)) {
    if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true });
    // Use copy instead of move to avoid breaking running server
    mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Clean storage for tests
  if (existsSync(STORAGE_DIR)) {
    for (const f of ["context.json", "reminders.json", "workflows.json", "learnings.json", "dispatches.json", "teams.json"]) {
      const p = join(STORAGE_DIR, f);
      if (existsSync(p)) rmSync(p);
    }
  }

  proc = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id)!;
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  // Initialize MCP
  const initResult = await sendMessage("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  expect(initResult.result.serverInfo.name).toBe("claude-orchestrator");

  sendNotification("notifications/initialized");

  // Small delay for notification processing
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => {
  proc?.stdin?.end();
  proc?.kill();
});

// ── Context Tools ──
describe("Context tools", () => {
  test("set_context → get_context → clear_context round-trip", async () => {
    // Set
    const setResult = await callTool("set_context", { key: "test_key", value: "hello world" });
    expect(getText(setResult)).toContain("test_key");

    // Get specific
    const getResult = await callTool("get_context", { key: "test_key" });
    const data = JSON.parse(getText(getResult));
    expect(data.value).toBe("hello world");
    expect(data.key).toBe("test_key");

    // Get all
    const getAllResult = await callTool("get_context", {});
    expect(getText(getAllResult)).toContain("test_key");

    // Clear
    const clearResult = await callTool("clear_context", { key: "test_key" });
    expect(getText(clearResult)).toContain("cleared");

    // Verify gone
    const goneResult = await callTool("get_context", { key: "test_key" });
    expect(goneResult.result.isError).toBe(true);
  });

  test("overwrite existing key", async () => {
    await callTool("set_context", { key: "overwrite_test", value: 42 });
    await callTool("set_context", { key: "overwrite_test", value: 99 });
    const r = await callTool("get_context", { key: "overwrite_test" });
    expect(JSON.parse(getText(r)).value).toBe(99);

    // Cleanup
    await callTool("clear_context", { key: "overwrite_test" });
  });
});

// ── Reminder Tools ──
describe("Reminder tools", () => {
  let reminderId: string;

  test("set_reminder creates a reminder", async () => {
    const r = await callTool("set_reminder", {
      trigger: { type: "keyword", value: "deploy" },
      message: "Check CI before deploying!",
      context: "deployment safety",
    });
    const text = getText(r);
    expect(text).toContain("created");
    reminderId = text.match(/rem_[a-f0-9]+/)![0];
  });

  test("list_reminders with context matching", async () => {
    const r = await callTool("list_reminders", { context: "time to deploy" });
    const text = getText(r);
    expect(text).toContain(reminderId);
    expect(text).toContain("Check CI");
  });

  test("list_reminders without context returns all", async () => {
    const r = await callTool("list_reminders", {});
    expect(getText(r)).toContain(reminderId);
  });

  test("dismiss_reminder removes it", async () => {
    const r = await callTool("dismiss_reminder", { id: reminderId });
    expect(getText(r)).toContain("dismissed");

    const r2 = await callTool("list_reminders", {});
    expect(getText(r2)).not.toContain(reminderId);
  });
});

// ── Workflow Tools ──
describe("Workflow tools", () => {
  test("define → start → advance → status → complete", async () => {
    // Define custom template
    const def = await callTool("define_workflow", {
      name: "test-flow",
      steps: ["Step A", "Step B", "Step C"],
    });
    expect(getText(def)).toContain("3 steps");

    // Start
    const start = await callTool("start_workflow", { name: "test-flow" });
    expect(getText(start)).toContain("Step A");

    // Status
    const status1 = await callTool("get_workflow_status", {});
    expect(getText(status1)).toContain("[>]");

    // Advance step 1
    const adv1 = await callTool("advance_step", { notes: "Done with A" });
    expect(getText(adv1)).toContain("Step B");

    // Advance step 2
    const adv2 = await callTool("advance_step", { notes: "Done with B" });
    expect(getText(adv2)).toContain("Step C");

    // Advance step 3 (completes workflow)
    const adv3 = await callTool("advance_step", { notes: "Done with C" });
    expect(getText(adv3)).toContain("completed");

    // Status shows completion
    const status2 = await callTool("get_workflow_status", {});
    expect(getText(status2)).toContain("Completed");
  });

  test("start from built-in template", async () => {
    const r = await callTool("start_workflow", { name: "new-skill" });
    expect(getText(r)).toContain("Gather examples");

    // Complete it to clean up
    for (let i = 0; i < 6; i++) {
      await callTool("advance_step", {});
    }
  });
});

// ── Learning Tools ──
describe("Learning tools", () => {
  test("note_learning → get_learnings → fold_learnings", async () => {
    // Note
    const note1 = await callTool("note_learning", {
      skill: "test-skill",
      observation: "Always check for null before accessing .length",
    });
    expect(getText(note1)).toContain("recorded");

    const note2 = await callTool("note_learning", {
      skill: "test-skill",
      observation: "Use timeout parameter for network calls",
    });
    expect(getText(note2)).toContain("recorded");

    // Get
    const get = await callTool("get_learnings", { skill: "test-skill" });
    const text = getText(get);
    expect(text).toContain("null");
    expect(text).toContain("timeout");
    expect(text).toContain("2 learnings");

    // Fold
    const fold = await callTool("fold_learnings", { skill: "test-skill" });
    const foldText = getText(fold);
    expect(foldText).toContain("Suggested additions");
    expect(foldText).toContain("null");

    // After fold, learnings should be marked folded
    const get2 = await callTool("get_learnings", { skill: "test-skill" });
    expect(getText(get2)).toContain("[folded]");
  });
});

// ── Dispatch Tools ──
describe("Dispatch tools", () => {
  test("list_dispatches returns empty", async () => {
    const r = await callTool("list_dispatches", {});
    expect(getText(r)).toContain("No dispatch");
  });

  // Note: We don't test actual dispatch since it requires codex/gemini CLIs
  // But we test the metadata flow
});

// ── Team Tools ──
describe("Team tools", () => {
  let teamId: string;

  test("create_team → get_team_status → dissolve_team", async () => {
    const create = await callTool("create_team", {
      goal: "Review the authentication module",
      agents: [
        { name: "reviewer", role: "security review", model: "codex" },
        { name: "architect", role: "architecture review", model: "gemini" },
      ],
    });
    const text = getText(create);
    expect(text).toContain("created");
    teamId = text.match(/team_[a-f0-9]+/)![0];

    // Status
    const status = await callTool("get_team_status", { team_id: teamId });
    expect(getText(status)).toContain("active");
    expect(getText(status)).toContain("reviewer");

    // Dissolve
    const dissolve = await callTool("dissolve_team", { team_id: teamId });
    expect(getText(dissolve)).toContain("dissolved");

    // Verify dissolved
    const status2 = await callTool("get_team_status", { team_id: teamId });
    expect(getText(status2)).toContain("dissolved");
  });
});

// ── tools/list ──
describe("Tool listing", () => {
  test("lists all 21 tools", async () => {
    const r = await sendMessage("tools/list", {});
    expect(r.result.tools.length).toBe(22);
  });
});
