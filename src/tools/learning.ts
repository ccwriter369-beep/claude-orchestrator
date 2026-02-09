import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { LearningsStore, Learning, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { genId, nowISO, ok, err } from "../util";

const FILE = "learnings.json";
const DEFAULT: LearningsStore = { schema_version: 1, skills: {} };
const SKILLS_DIR = join(homedir(), ".claude", "skills");

export const learningTools: ToolDef[] = [
  {
    name: "note_learning",
    description: "Record a pattern, gotcha, or improvement observation for a skill",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name (e.g., 'browser-testing')" },
        observation: { type: "string", description: "What was learned" },
      },
      required: ["skill", "observation"],
    },
    handler: async (args) => {
      const skill = args.skill as string;
      const observation = args.observation as string;
      if (!skill || !observation) return err("skill and observation are required");

      const learning: Learning = {
        id: genId("lrn"),
        observation,
        created_at: nowISO(),
        folded: false,
      };

      updateStore<LearningsStore>(FILE, DEFAULT, (store) => {
        const existing = store.skills[skill]?.observations ?? [];
        return {
          ...store,
          skills: {
            ...store.skills,
            [skill]: { observations: [...existing, learning] },
          },
        };
      });

      return ok(`Learning "${learning.id}" recorded for skill "${skill}"`);
    },
  },
  {
    name: "get_learnings",
    description: "Retrieve accumulated learnings for a skill (paginated)",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name (omit for all skills)" },
        limit: { type: "number", description: "Max results per skill (default 20)" },
      },
    },
    handler: async (args) => {
      const skill = args.skill as string | undefined;
      const limit = (args.limit as number) || 20;
      const store = readStore<LearningsStore>(FILE, DEFAULT);

      if (Object.keys(store.skills).length === 0) {
        return ok("No learnings recorded yet");
      }

      const sections: string[] = [];
      const skillNames = skill ? [skill] : Object.keys(store.skills);

      for (const name of skillNames) {
        const data = store.skills[name];
        if (!data) continue;

        const obs = data.observations.slice(0, limit);
        const lines = obs.map((o) => {
          const tag = o.folded ? " [folded]" : "";
          return `- **${o.id}**${tag}: ${o.observation} _(${o.created_at})_`;
        });

        const remaining = data.observations.length - obs.length;
        if (remaining > 0) lines.push(`  _...and ${remaining} more_`);

        sections.push(`### ${name} (${data.observations.length} learnings)\n${lines.join("\n")}`);
      }

      if (sections.length === 0) {
        return ok(skill ? `No learnings for "${skill}"` : "No learnings recorded");
      }

      return ok(sections.join("\n\n"));
    },
  },
  {
    name: "fold_learnings",
    description:
      "Generate suggested SKILL.md updates from unfolded learnings. Returns text only — apply via Edit tool",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name to fold learnings for" },
      },
      required: ["skill"],
    },
    handler: async (args) => {
      const skill = args.skill as string;
      if (!skill) return err("skill is required");

      const store = readStore<LearningsStore>(FILE, DEFAULT);
      const data = store.skills[skill];
      if (!data) return err(`No learnings for skill "${skill}"`);

      const unfolded = data.observations.filter((o) => !o.folded);
      if (unfolded.length === 0) return ok(`All learnings for "${skill}" are already folded`);

      // Read current SKILL.md
      const skillPath = join(SKILLS_DIR, skill, "SKILL.md");
      let currentSkillMd = "";
      if (existsSync(skillPath)) {
        currentSkillMd = readFileSync(skillPath, "utf-8");
      }

      // Build suggestion
      const learningSections = unfolded.map((o) => `- ${o.observation}`).join("\n");

      const suggestion = [
        `## Suggested additions for ${skill}/SKILL.md`,
        "",
        currentSkillMd
          ? `Current SKILL.md path: ${skillPath}`
          : `No SKILL.md found at ${skillPath} — create one`,
        "",
        "### Learnings to incorporate:",
        "",
        learningSections,
        "",
        "---",
        `${unfolded.length} unfolded observation(s). After applying, these will be marked as folded.`,
      ].join("\n");

      // Mark as folded
      updateStore<LearningsStore>(FILE, DEFAULT, (s) => ({
        ...s,
        skills: {
          ...s.skills,
          [skill]: {
            observations: data.observations.map((o) =>
              unfolded.find((u) => u.id === o.id) ? { ...o, folded: true } : o
            ),
          },
        },
      }));

      return ok(suggestion);
    },
  },
];
