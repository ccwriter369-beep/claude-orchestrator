import type { WorkflowsStore, WorkflowStep, ActiveWorkflow, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { nowISO, ok, err } from "../util";

const FILE = "workflows.json";

const BUILTIN_TEMPLATES: Record<string, string[]> = {
  "orchestrator": [
    // 1 — Intake
    "INTAKE: Get task and understand scope. Read the request fully. Use get_context for prior state. Check get_workflow_status for anything in-flight. Ask clarifying questions NOW, not mid-build.",
    // 2 — Goal mapping
    "GOALS: Read task deeply, list and catalogue ALL goals. Break ambiguous goals into concrete deliverables. Store goals with set_context(key='goals'). Two passes: first for explicit goals, second for implied ones.",
    // 3 — Parallel research
    "RESEARCH: Dispatch Codex AND Gemini in parallel. Codex: codebase analysis + implementation plan + risks. Gemini: architecture review + best practices research + alternative approaches. Use dispatch() x2. Both get the goals list. Check get_dispatch_result() to monitor.",
    // 4 — Agent team review
    "AGENT REVIEW: Create agent team with /technical-planning skill for the 3rd set of eyes. create_team() with planner role. Agents see things dispatched models miss. Now you have 3 independent perspectives in flight.",
    // 5 — Monitor parallel work
    "MONITOR: Check all workers. get_dispatch_result() for Codex + Gemini. get_team_status() for agent team. Don't block — if one is slow, review what's already back. Note quality issues with note_learning().",
    // 6 — Synthesize
    "SYNTHESIZE: Collect all three outputs before writing the plan. Compare where they agree (high confidence), disagree (needs decision), and what each uniquely caught. Resolve conflicts. This is where orchestrator judgment matters most.",
    // 7 — Plan with parallel scheduling
    "PLAN: Use /technical-planning to write the implementation plan. KEY: Schedule work so Codex, Gemini, and agent teams stay busy. Priority order: Codex 1st, Agent Team 2nd, Gemini 3rd, Agent Team Two 4th. Tests can be written in parallel with implementation. define_workflow() with the steps.",
    // 8 — Approval gate
    "APPROVE: Present plan to user. Be explicit about what each worker will do and in what order. Show the parallel schedule. Plan starts only after user approves. start_workflow() once approved.",
    // 9 — Execute and assign
    "EXECUTE: Orchestrator assigns tasks, collects results, marks completion. dispatch() to models, create_team() for agents. advance_step() as phases complete. Watch for blockers — if one task blocks others, escalate or reassign. Keep workers busy.",
    // 10 — Code review
    "CODE REVIEW: All three review the completed work. dispatch(codex) for security + correctness. dispatch(gemini) for architecture + docs. Agent team for integration testing. Parallel — don't wait for one to start the next.",
    // 11 — Review triage
    "TRIAGE REVIEWS: Collect all code reviews. Categorize: must-fix (bugs, security), should-fix (patterns, consistency), nice-to-have (style). Don't fix everything at once — prioritize must-fix first.",
    // 12 — Corrections plan
    "CORRECTIONS: Make plan for fixes. Assign must-fix items to Codex (strongest at precise fixes). Send pattern issues to agents. Only dispatch to Gemini if there are architecture-level changes.",
    // 13 — Test
    "TEST: Run full test suite. If tests were written in parallel (step 7), run them now. If not, write them. Tests reveal what reviews missed. note_learning() for any gotchas found.",
    // 14 — Fix failures
    "FIX: Make corrections from test failures. Re-run tests after each fix. Don't batch fixes — fix one, verify, next. This prevents cascading breakage.",
    // 15 — Commit
    "COMMIT: Use /git-commit-helper skill. Conventional commit format. Message should reference the goals from step 2. Stage specific files, not git add -A.",
    // 16 — Push
    "PUSH: Simple push = just push. Anything more complex (PR, protected branch, multi-repo) = use /github-best-practices skill. Verify push succeeded.",
    // 17 — Clean up and learn
    "CLEAN UP: Three parts. (1) Feedback: dispatch(codex) and dispatch(gemini) asking 'what did you learn from this task that could improve future work?' Collect and review their suggestions. (2) Self-reflect: note_learning() for patterns that came up repeatedly, things that slowed you down, tools that worked well or poorly. fold_learnings() if enough accumulated. (3) Tidy: dissolve_team(), update MEMORY.md if the project is significant, clear temp context with clear_context().",
  ],
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
    description: "Begin a workflow from a template or custom steps. Templates: orchestrator (full 17-step pipeline), new-skill, multi-model-critique, publish-to-github",
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
