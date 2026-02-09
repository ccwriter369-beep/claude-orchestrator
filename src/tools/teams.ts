import type { TeamsStore, Team, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { genId, nowISO, ok, err } from "../util";

const FILE = "teams.json";
const DEFAULT: TeamsStore = { schema_version: 1, teams: [] };

export const teamTools: ToolDef[] = [
  {
    name: "create_team",
    description:
      "Define an agent team with a goal and roles. Wraps Claude's TeamCreate for structured coordination",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the team should accomplish" },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Agent name/role identifier" },
              role: { type: "string", description: "What this agent does" },
              model: { type: "string", enum: ["codex", "gemini", "claude"], description: "Which model to use" },
            },
            required: ["name", "role"],
          },
          description: "Team members with roles",
        },
      },
      required: ["goal", "agents"],
    },
    handler: async (args) => {
      const goal = args.goal as string;
      const agents = args.agents as Team["agents"];

      if (!goal || !agents?.length) return err("goal and agents[] are required");

      const team: Team = {
        id: genId("team"),
        goal,
        agents,
        status: "active",
        created_at: nowISO(),
      };

      updateStore<TeamsStore>(FILE, DEFAULT, (store) => ({
        ...store,
        teams: [...store.teams, team],
      }));

      const agentList = agents
        .map((a) => `- **${a.name}** (${a.role})${a.model ? ` [${a.model}]` : ""}`)
        .join("\n");

      return ok(
        `Team "${team.id}" created\n**Goal**: ${goal}\n**Agents**:\n${agentList}\n\nUse Claude's TeamCreate/Task tools to spawn agents, then track progress with get_team_status.`
      );
    },
  },
  {
    name: "get_team_status",
    description: "Get status of active teams and their agents",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "Specific team (omit for all active teams)" },
      },
    },
    handler: async (args) => {
      const teamId = args.team_id as string | undefined;
      const store = readStore<TeamsStore>(FILE, DEFAULT);

      let teams: Team[];
      if (teamId) {
        const team = store.teams.find((t) => t.id === teamId);
        if (!team) return err(`Team "${teamId}" not found`);
        teams = [team];
      } else {
        teams = store.teams.filter((t) => t.status === "active");
      }

      if (teams.length === 0) return ok("No active teams");

      const sections = teams.map((t) => {
        const agents = t.agents
          .map((a) => `  - **${a.name}** (${a.role})${a.model ? ` [${a.model}]` : ""}`)
          .join("\n");

        return `### ${t.id} — ${t.status}\n**Goal**: ${t.goal}\n**Created**: ${t.created_at}\n**Agents**:\n${agents}`;
      });

      return ok(sections.join("\n\n"));
    },
  },
  {
    name: "dissolve_team",
    description: "Mark a team as dissolved/completed",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "Team ID to dissolve" },
      },
      required: ["team_id"],
    },
    handler: async (args) => {
      const teamId = args.team_id as string;
      if (!teamId) return err("team_id is required");

      const store = readStore<TeamsStore>(FILE, DEFAULT);
      const team = store.teams.find((t) => t.id === teamId);
      if (!team) return err(`Team "${teamId}" not found`);
      if (team.status !== "active") return err(`Team "${teamId}" is already ${team.status}`);

      updateStore<TeamsStore>(FILE, DEFAULT, (s) => ({
        ...s,
        teams: s.teams.map((t) =>
          t.id === teamId
            ? { ...t, status: "dissolved" as const, completed_at: nowISO() }
            : t
        ),
      }));

      return ok(`Team "${teamId}" dissolved`);
    },
  },
];
