// ── Schema versioning ──
export interface Versioned {
  schema_version: number;
}

// ── Reminders ──
export interface ReminderTrigger {
  type: "keyword" | "event" | "always";
  value?: string;
}

export interface Reminder {
  id: string;
  trigger: ReminderTrigger;
  message: string;
  context?: string;
  created_at: string;
  fired_count: number;
  last_fired_at?: string;
}

export interface RemindersStore extends Versioned {
  reminders: Reminder[];
}

// ── Workflows ──
export interface WorkflowStep {
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  notes?: string;
  completed_at?: string;
}

export interface WorkflowTemplate {
  name: string;
  steps: string[];
}

export interface ActiveWorkflow {
  name: string;
  current_step: number;
  steps: WorkflowStep[];
  started_at: string;
  completed_at?: string;
}

export interface WorkflowsStore extends Versioned {
  templates: Record<string, WorkflowTemplate>;
  active?: ActiveWorkflow;
}

// ── Skill Learning ──
export interface Learning {
  id: string;
  observation: string;
  created_at: string;
  folded: boolean;
}

export interface LearningsStore extends Versioned {
  skills: Record<string, { observations: Learning[] }>;
}

// ── Session Context ──
export interface ContextEntry {
  value: unknown;
  set_at: string;
}

export interface ContextStore extends Versioned {
  entries: Record<string, ContextEntry>;
}

// ── Dispatch ──
export type DispatchStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface DispatchTask {
  id: string;
  model: "codex" | "gemini";
  prompt: string;
  options?: {
    yolo?: boolean;
    timeout?: number;
    workdir?: string;
    follow_up?: boolean;
  };
  session_dir: string;
  output_file: string;
  status: DispatchStatus;
  pid?: number;
  exit_code?: number;
  duration_s?: number;
  output?: string;
  created_at: string;
  completed_at?: string;
  error?: string;
}

export interface DispatchesStore extends Versioned {
  tasks: DispatchTask[];
}

// ── Agent Teams ──
export interface TeamAgent {
  name: string;
  role: string;
  model?: "codex" | "gemini" | "claude";
}

export interface Team {
  id: string;
  goal: string;
  agents: TeamAgent[];
  status: "active" | "completed" | "dissolved";
  created_at: string;
  completed_at?: string;
}

export interface TeamsStore extends Versioned {
  teams: Team[];
}

// ── MCP Tool Definition ──
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
