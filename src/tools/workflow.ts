import type { WorkflowsStore, WorkflowStep, ActiveWorkflow, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { nowISO, ok, err } from "../util";

const FILE = "workflows.json";

const BUILTIN_TEMPLATES: Record<string, string[]> = {
  "new-skill": [
    "Gather examples and requirements",
    "Plan skill structure and SKILL.md",
    "Create skill directory and files",
    "Write SKILL.md with instructions",
    "Test the skill end-to-end",
    "Push to GitHub",
  ],
  "multi-model-critique": [
    "Draft the artifact to review",
    "Dispatch to Codex for critical review",
    "Dispatch to Gemini for parallel review",
    "Synthesize feedback from both models",
    "Revise artifact with feedback",
  ],
  "publish-to-github": [
    "Verify all changes are committed",
    "Run tests and verify passing",
    "Create GitHub repo if needed",
    "Push to remote",
    "Update MEMORY.md with new entry",
  ],
};

const DEFAULT: WorkflowsStore = {
  schema_version: 1,
  templates: Object.fromEntries(
    Object.entries(BUILTIN_TEMPLATES).map(([name, steps]) => [name, { name, steps }])
  ),
};

export const workflowTools: ToolDef[] = [
  {
    name: "define_workflow",
    description: "Create or update a reusable workflow template",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Template name" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered step descriptions",
        },
      },
      required: ["name", "steps"],
    },
    handler: async (args) => {
      const name = args.name as string;
      const steps = args.steps as string[];
      if (!name || !steps?.length) return err("name and steps[] are required");

      updateStore<WorkflowsStore>(FILE, DEFAULT, (store) => ({
        ...store,
        templates: {
          ...store.templates,
          [name]: { name, steps },
        },
      }));

      return ok(`Workflow template "${name}" defined with ${steps.length} steps`);
    },
  },
  {
    name: "start_workflow",
    description: "Begin a workflow from a template or custom steps. Templates: new-skill, multi-model-critique, publish-to-github",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name (template name or custom)" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Custom steps (overrides template if provided)",
        },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const name = args.name as string;
      const customSteps = args.steps as string[] | undefined;

      const store = readStore<WorkflowsStore>(FILE, DEFAULT);

      // Check for already active workflow
      if (store.active && !store.active.completed_at) {
        return err(
          `Workflow "${store.active.name}" is already active (step ${store.active.current_step + 1}/${store.active.steps.length}). Complete or advance it first.`
        );
      }

      // Resolve steps
      let steps: string[];
      if (customSteps?.length) {
        steps = customSteps;
      } else if (store.templates[name]) {
        steps = store.templates[name].steps;
      } else {
        return err(
          `No template "${name}" found. Available: ${Object.keys(store.templates).join(", ")}. Or provide custom steps[].`
        );
      }

      const active: ActiveWorkflow = {
        name,
        current_step: 0,
        steps: steps.map((desc) => ({
          description: desc,
          status: "pending",
        })),
        started_at: nowISO(),
      };

      // Mark first step as in_progress
      active.steps[0].status = "in_progress";

      updateStore<WorkflowsStore>(FILE, DEFAULT, (s) => ({
        ...s,
        active,
      }));

      const stepList = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
      return ok(`Workflow "${name}" started:\n${stepList}\n\nCurrent: Step 1 — ${steps[0]}`);
    },
  },
  {
    name: "get_workflow_status",
    description: "Get the current workflow step, progress, and notes",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      const store = readStore<WorkflowsStore>(FILE, DEFAULT);

      if (!store.active) {
        const templates = Object.keys(store.templates);
        return ok(`No active workflow. Available templates: ${templates.join(", ")}`);
      }

      const w = store.active;
      const completed = w.steps.filter((s) => s.status === "completed").length;
      const total = w.steps.length;

      const lines = w.steps.map((s, i) => {
        const icon =
          s.status === "completed" ? "[x]" :
          s.status === "in_progress" ? "[>]" :
          s.status === "skipped" ? "[-]" : "[ ]";
        const notes = s.notes ? ` — ${s.notes}` : "";
        return `${icon} ${i + 1}. ${s.description}${notes}`;
      });

      const status = w.completed_at ? "Completed" : `Step ${w.current_step + 1}/${total}`;
      return ok(
        `**${w.name}** — ${status} (${completed}/${total} done)\n\n${lines.join("\n")}`
      );
    },
  },
  {
    name: "advance_step",
    description: "Complete the current workflow step and move to the next",
    inputSchema: {
      type: "object",
      properties: {
        notes: { type: "string", description: "Notes about what was done in this step" },
      },
    },
    handler: async (args) => {
      const notes = args.notes as string | undefined;

      const store = readStore<WorkflowsStore>(FILE, DEFAULT);

      if (!store.active) return err("No active workflow");
      if (store.active.completed_at) return err("Workflow already completed");

      const w = { ...store.active };
      const steps = w.steps.map((s) => ({ ...s }));
      const current = w.current_step;

      // Complete current step
      steps[current] = {
        ...steps[current],
        status: "completed",
        notes,
        completed_at: nowISO(),
      };

      // Move to next step or complete workflow
      if (current + 1 < steps.length) {
        steps[current + 1] = { ...steps[current + 1], status: "in_progress" };
        w.current_step = current + 1;
        w.steps = steps;

        updateStore<WorkflowsStore>(FILE, DEFAULT, (s) => ({ ...s, active: w }));

        return ok(
          `Step ${current + 1} completed. Now on step ${current + 2}/${steps.length}: ${steps[current + 1].description}`
        );
      } else {
        w.steps = steps;
        w.completed_at = nowISO();

        updateStore<WorkflowsStore>(FILE, DEFAULT, (s) => ({ ...s, active: w }));

        return ok(`Workflow "${w.name}" completed! All ${steps.length} steps done.`);
      }
    },
  },
];
