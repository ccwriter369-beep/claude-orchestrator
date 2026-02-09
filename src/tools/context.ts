import type { ContextStore, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { nowISO, ok, err } from "../util";

const FILE = "context.json";
const DEFAULT: ContextStore = { schema_version: 1, entries: {} };

export const contextTools: ToolDef[] = [
  {
    name: "set_context",
    description: "Persist a key-value pair across sessions",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Context key" },
        value: { description: "Value to store (any JSON-serializable type)" },
      },
      required: ["key", "value"],
    },
    handler: async (args) => {
      const key = args.key as string;
      const value = args.value;
      if (!key) return err("key is required");

      updateStore<ContextStore>(FILE, DEFAULT, (store) => ({
        ...store,
        entries: {
          ...store.entries,
          [key]: { value, set_at: nowISO() },
        },
      }));

      return ok(`Context "${key}" set`);
    },
  },
  {
    name: "get_context",
    description: "Retrieve one or all session context entries",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific key to retrieve (omit for all)" },
      },
    },
    handler: async (args) => {
      const store = readStore<ContextStore>(FILE, DEFAULT);
      const key = args.key as string | undefined;

      if (key) {
        const entry = store.entries[key];
        if (!entry) return err(`No context entry for "${key}"`);
        return ok(JSON.stringify({ key, ...entry }, null, 2));
      }

      const keys = Object.keys(store.entries);
      if (keys.length === 0) return ok("No context entries stored");

      const summary = keys.map((k) => {
        const e = store.entries[k];
        const val = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
        const display = val.length > 80 ? val.slice(0, 77) + "..." : val;
        return `- **${k}**: ${display} _(set ${e.set_at})_`;
      });
      return ok(summary.join("\n"));
    },
  },
  {
    name: "clear_context",
    description: "Remove a session context entry",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to remove" },
      },
      required: ["key"],
    },
    handler: async (args) => {
      const key = args.key as string;
      if (!key) return err("key is required");

      const store = readStore<ContextStore>(FILE, DEFAULT);
      if (!store.entries[key]) return err(`No context entry for "${key}"`);

      const { [key]: _, ...rest } = store.entries;
      updateStore<ContextStore>(FILE, DEFAULT, (s) => ({
        ...s,
        entries: rest,
      }));

      return ok(`Context "${key}" cleared`);
    },
  },
];
