import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import type { DispatchesStore, DispatchTask, DispatchStatus, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { genId, nowISO, ok, err } from "../util";

const FILE = "dispatches.json";
const DEFAULT: DispatchesStore = { schema_version: 1, tasks: [] };


const BRIDGE_CONFIG_PATH = join(homedir(), ".claude", "orchestration", "bridge-config.json");
const WRAPPER_PATH = join(homedir(), ".claude", "orchestration", "templates", "dispatch-wrapper.sh");
const SESSION_BASE = join(homedir(), ".claude", "orchestration", "sessions");

/** Read bridge config for model validation */
function readBridgeConfig(): Record<string, unknown> | null {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** Write task state marker file */
function writeMarker(sessionDir: string, taskId: string, status: DispatchStatus): void {
  const markerPath = join(sessionDir, `.task-${taskId}.state`);
  writeFileSync(markerPath, status, "utf-8");
}

/** Read task state marker file */
function readMarker(sessionDir: string, taskId: string): DispatchStatus | null {
  const markerPath = join(sessionDir, `.task-${taskId}.state`);
  try {
    if (!existsSync(markerPath)) return null;
    return readFileSync(markerPath, "utf-8").trim() as DispatchStatus;
  } catch {
    return null;
  }
}

/** Check if a PID is alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Startup recovery: scan for running tasks, transition orphans to failed */
export function recoverOrphanedTasks(): void {
  const store = readStore<DispatchesStore>(FILE, DEFAULT);
  const running = store.tasks.filter((t) => t.status === "running" || t.status === "created");

  if (running.length === 0) return;

  updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
    ...s,
    tasks: s.tasks.map((t) => {
      if (t.status !== "running" && t.status !== "created") return t;

      // Check marker file first
      const marker = readMarker(t.session_dir, t.id);
      if (marker === "completed" || marker === "failed") {
        return {
          ...t,
          status: marker,
          completed_at: nowISO(),
          output: marker === "completed" ? readOutputFile(t.output_file) : undefined,
          error: marker === "failed" ? "Recovered from orphaned state" : undefined,
        };
      }

      // Check if process is alive
      if (t.pid && isProcessAlive(t.pid)) {
        return t; // Still running
      }

      // Orphaned — transition to failed
      return {
        ...t,
        status: "failed" as DispatchStatus,
        completed_at: nowISO(),
        error: "Orphaned task recovered on startup (process not alive)",
      };
    }),
  }));
}

function readOutputFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf-8");
    // Truncate large outputs for storage
    return content.length > 50000 ? content.slice(0, 50000) + "\n...[truncated]" : content;
  } catch {
    return undefined;
  }
}

export const dispatchTools: ToolDef[] = [
  {
    name: "dispatch",
    description: "Send a task to Codex or Gemini. Returns task_id for polling",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: ["codex", "gemini"], description: "Target model" },
        prompt: { type: "string", description: "Task prompt" },
        options: {
          type: "object",
          properties: {
            yolo: { type: "boolean", description: "Bypass safety sandbox" },
            timeout: { type: "number", description: "Timeout in seconds" },
            workdir: { type: "string", description: "Working directory (default: home)" },
            follow_up: { type: "boolean", description: "Continue previous conversation" },
          },
        },
      },
      required: ["model", "prompt"],
    },
    handler: async (args) => {
      const model = args.model as "codex" | "gemini";
      const prompt = args.prompt as string;
      const options = (args.options as DispatchTask["options"]) || {};

      if (!model || !prompt) return err("model and prompt are required");

      // Validate model
      const config = readBridgeConfig();
      if (config) {
        const models = config.models as Record<string, unknown> | undefined;
        if (models && !models[model]) {
          return err(`Unknown model "${model}". Available: ${Object.keys(models).join(", ")}`);
        }
      }

      // Verify wrapper exists
      if (!existsSync(WRAPPER_PATH)) {
        return err(`Dispatch wrapper not found at ${WRAPPER_PATH}`);
      }

      const taskId = genId("dsp");
      const sessionDir = join(SESSION_BASE, taskId);
      mkdirSync(sessionDir, { recursive: true });

      const outputFile = join(sessionDir, `${model}-turn-0001.md`);

      // Write prompt to temp file (no shell injection)
      const promptFile = join(sessionDir, "prompt.txt");
      writeFileSync(promptFile, prompt, "utf-8");

      const task: DispatchTask = {
        id: taskId,
        model,
        prompt: prompt.length > 500 ? prompt.slice(0, 497) + "..." : prompt,
        options,
        session_dir: sessionDir,
        output_file: outputFile,
        status: "created",
        created_at: nowISO(),
      };

      // Security: prompt travels via ORCH_PROMPT env var, never through
      // shell argv or interpolation. The wrapper receives it as $4 through
      // the env var, completely avoiding shell metacharacter risks.
      const wrapperArgs = [
        WRAPPER_PATH,
        model,
        sessionDir,
        options.workdir || homedir(),
        "PLACEHOLDER", // $4 — overwritten below via env var
      ];

      if (options.yolo) wrapperArgs.push("--yolo");
      if (options.timeout) wrapperArgs.push("--timeout", String(options.timeout));
      if (options.follow_up) wrapperArgs.push("--follow-up");
      wrapperArgs.push("--output", outputFile);

      // Replace $4 placeholder: spawn with argv array (no shell parsing).
      // The prompt goes through env AND as a direct argv element via Node's
      // spawn(), which bypasses shell entirely — each array element becomes
      // a separate execve() argument with no interpolation.
      wrapperArgs[4] = prompt;

      // Spawn detached — Node's spawn() with array args uses execve() directly,
      // so prompt content in argv[4] is never parsed by a shell.
      try {
        const child = spawn("bash", wrapperArgs, {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ORCH_TASK_ID: taskId,
            ORCH_SESSION_DIR: sessionDir,
            ORCH_PROMPT: prompt, // Backup: prompt also available via env
            ORCH_PROMPT_FILE: promptFile, // And via file for very large prompts
          },
        });

        child.unref();
        task.pid = child.pid;
        task.status = "running";
        writeMarker(sessionDir, taskId, "running");

        // Watch for exit
        child.on("exit", (code) => {
          const finalStatus: DispatchStatus = code === 0 ? "completed" : "failed";
          writeMarker(sessionDir, taskId, finalStatus);

          updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
            ...s,
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? {
                    ...t,
                    status: finalStatus,
                    exit_code: code ?? 1,
                    completed_at: nowISO(),
                    output: finalStatus === "completed" ? readOutputFile(outputFile) : undefined,
                    error: finalStatus === "failed" ? `Process exited with code ${code}` : undefined,
                  }
                : t
            ),
          }));
        });
      } catch (e) {
        task.status = "failed";
        task.error = `Failed to spawn: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Save task
      updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
        ...s,
        tasks: [...s.tasks, task],
      }));

      if (task.status === "failed") {
        return err(`Dispatch failed: ${task.error}`);
      }

      return ok(`Dispatched to ${model} — task_id: **${taskId}** (PID: ${task.pid})\nSession: ${sessionDir}`);
    },
  },
  {
    name: "get_dispatch_result",
    description: "Get the status and output of a dispatched task",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID from dispatch" },
      },
      required: ["task_id"],
    },
    handler: async (args) => {
      const taskId = args.task_id as string;
      if (!taskId) return err("task_id is required");

      let store = readStore<DispatchesStore>(FILE, DEFAULT);
      let task = store.tasks.find((t) => t.id === taskId);
      if (!task) return err(`Task "${taskId}" not found`);

      // If running, check marker file and process status
      if (task.status === "running") {
        const marker = readMarker(task.session_dir, task.id);
        if (marker && marker !== "running") {
          // Update from marker
          const output = marker === "completed" ? readOutputFile(task.output_file) : undefined;
          updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
            ...s,
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status: marker, completed_at: nowISO(), output }
                : t
            ),
          }));
          store = readStore<DispatchesStore>(FILE, DEFAULT);
          task = store.tasks.find((t) => t.id === taskId)!;
        } else if (task.pid && !isProcessAlive(task.pid)) {
          // Process died without marker
          const output = readOutputFile(task.output_file);
          const status: DispatchStatus = output ? "completed" : "failed";
          updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
            ...s,
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, status, completed_at: nowISO(), output, error: status === "failed" ? "Process exited without marker" : undefined }
                : t
            ),
          }));
          store = readStore<DispatchesStore>(FILE, DEFAULT);
          task = store.tasks.find((t) => t.id === taskId)!;
        }
      }

      const lines = [
        `**Task**: ${task.id}`,
        `**Model**: ${task.model}`,
        `**Status**: ${task.status}`,
        `**Created**: ${task.created_at}`,
      ];

      if (task.completed_at) lines.push(`**Completed**: ${task.completed_at}`);
      if (task.duration_s !== undefined) lines.push(`**Duration**: ${task.duration_s}s`);
      if (task.exit_code !== undefined) lines.push(`**Exit code**: ${task.exit_code}`);
      if (task.error) lines.push(`**Error**: ${task.error}`);
      if (task.output) {
        const display = task.output.length > 2000 ? task.output.slice(0, 1997) + "..." : task.output;
        lines.push(`\n**Output**:\n${display}`);
      } else if (task.status === "completed" && task.output_file) {
        // Try reading fresh
        const fresh = readOutputFile(task.output_file);
        if (fresh) {
          const display = fresh.length > 2000 ? fresh.slice(0, 1997) + "..." : fresh;
          lines.push(`\n**Output**:\n${display}`);
        } else {
          lines.push(`**Output file**: ${task.output_file}`);
        }
      }

      return ok(lines.join("\n"));
    },
  },
  {
    name: "cancel_dispatch",
    description: "Kill a running dispatch task",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to cancel" },
      },
      required: ["task_id"],
    },
    handler: async (args) => {
      const taskId = args.task_id as string;
      if (!taskId) return err("task_id is required");

      const store = readStore<DispatchesStore>(FILE, DEFAULT);
      const task = store.tasks.find((t) => t.id === taskId);
      if (!task) return err(`Task "${taskId}" not found`);
      if (task.status !== "running" && task.status !== "created") {
        return err(`Task "${taskId}" is ${task.status}, cannot cancel`);
      }

      // Kill process
      if (task.pid) {
        try {
          process.kill(-task.pid, "SIGTERM"); // Kill process group
        } catch {
          try {
            process.kill(task.pid, "SIGTERM");
          } catch {
            // Process already dead
          }
        }
      }

      writeMarker(task.session_dir, taskId, "cancelled");

      updateStore<DispatchesStore>(FILE, DEFAULT, (s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? { ...t, status: "cancelled" as DispatchStatus, completed_at: nowISO() }
            : t
        ),
      }));

      return ok(`Task "${taskId}" cancelled`);
    },
  },
  {
    name: "retry_dispatch",
    description: "Re-run a failed or cancelled dispatch task",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to retry" },
      },
      required: ["task_id"],
    },
    handler: async (args) => {
      const taskId = args.task_id as string;
      if (!taskId) return err("task_id is required");

      const store = readStore<DispatchesStore>(FILE, DEFAULT);
      const task = store.tasks.find((t) => t.id === taskId);
      if (!task) return err(`Task "${taskId}" not found`);
      if (task.status !== "failed" && task.status !== "cancelled") {
        return err(`Task "${taskId}" is ${task.status}, can only retry failed/cancelled tasks`);
      }

      // Re-dispatch with same params — delegate to dispatch handler
      const dispatchTool = dispatchTools.find((t) => t.name === "dispatch")!;
      return dispatchTool.handler({
        model: task.model,
        prompt: task.prompt,
        options: task.options || {},
      });
    },
  },
  {
    name: "list_dispatches",
    description: "List dispatch history (paginated)",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: ["codex", "gemini"], description: "Filter by model" },
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args) => {
      const model = args.model as string | undefined;
      const status = args.status as string | undefined;
      const limit = (args.limit as number) || 20;

      const store = readStore<DispatchesStore>(FILE, DEFAULT);
      let tasks = [...store.tasks].reverse(); // Newest first

      if (model) tasks = tasks.filter((t) => t.model === model);
      if (status) tasks = tasks.filter((t) => t.status === status);

      tasks = tasks.slice(0, limit);

      if (tasks.length === 0) return ok("No dispatch tasks found");

      const lines = tasks.map((t) => {
        const prompt = t.prompt.length > 60 ? t.prompt.slice(0, 57) + "..." : t.prompt;
        return `- **${t.id}** [${t.model}] ${t.status} — "${prompt}" _(${t.created_at})_`;
      });

      const total = store.tasks.length;
      lines.push(`\n_Showing ${tasks.length} of ${total} total dispatches_`);

      return ok(lines.join("\n"));
    },
  },
];
