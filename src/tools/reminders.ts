import type { RemindersStore, Reminder, ToolDef } from "../types";
import { readStore, updateStore } from "../storage";
import { genId, nowISO, ok, err } from "../util";

const FILE = "reminders.json";
const DEFAULT: RemindersStore = { schema_version: 1, reminders: [] };

export const reminderTools: ToolDef[] = [
  {
    name: "set_reminder",
    description:
      "Create a contextual reminder. Trigger types: keyword (substring match), event (before_commit, after_error, session_start), always (fires every check)",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["keyword", "event", "always"] },
            value: { type: "string", description: "Keyword or event name (not needed for 'always')" },
          },
          required: ["type"],
        },
        message: { type: "string", description: "Reminder message" },
        context: { type: "string", description: "Optional context/notes" },
      },
      required: ["trigger", "message"],
    },
    handler: async (args) => {
      const trigger = args.trigger as Reminder["trigger"];
      const message = args.message as string;
      const context = args.context as string | undefined;

      if (!trigger?.type || !message) return err("trigger and message are required");

      const reminder: Reminder = {
        id: genId("rem"),
        trigger,
        message,
        context,
        created_at: nowISO(),
        fired_count: 0,
      };

      updateStore<RemindersStore>(FILE, DEFAULT, (store) => ({
        ...store,
        reminders: [...store.reminders, reminder],
      }));

      return ok(`Reminder "${reminder.id}" created (trigger: ${trigger.type}${trigger.value ? `="${trigger.value}"` : ""})`);
    },
  },
  {
    name: "list_reminders",
    description:
      "List reminders. When context is provided, returns only matching reminders and increments their fired_count",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Filter by trigger type: keyword, event, always" },
        context: { type: "string", description: "Current context to match against (fires matching reminders)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
    handler: async (args) => {
      const filter = args.filter as string | undefined;
      const context = args.context as string | undefined;
      const limit = (args.limit as number) || 20;

      let store = readStore<RemindersStore>(FILE, DEFAULT);
      let results = store.reminders;

      // Filter by trigger type
      if (filter) {
        results = results.filter((r) => r.trigger.type === filter);
      }

      // Context matching: fire matching reminders
      if (context) {
        const ctx = context.toLowerCase();
        const matched: Reminder[] = [];
        const now = nowISO();

        results = results.filter((r) => {
          if (r.trigger.type === "always") {
            matched.push(r);
            return true;
          }
          if (r.trigger.type === "keyword" && r.trigger.value) {
            if (ctx.includes(r.trigger.value.toLowerCase())) {
              matched.push(r);
              return true;
            }
          }
          if (r.trigger.type === "event" && r.trigger.value) {
            if (ctx.includes(r.trigger.value.toLowerCase())) {
              matched.push(r);
              return true;
            }
          }
          return false;
        });

        // Update fired_count for matched reminders
        if (matched.length > 0) {
          updateStore<RemindersStore>(FILE, DEFAULT, (s) => ({
            ...s,
            reminders: s.reminders.map((r) => {
              const m = matched.find((x) => x.id === r.id);
              if (m) {
                return { ...r, fired_count: r.fired_count + 1, last_fired_at: now };
              }
              return r;
            }),
          }));
        }
      }

      // Paginate
      results = results.slice(0, limit);

      if (results.length === 0) {
        return ok(context ? "No matching reminders for this context" : "No reminders set");
      }

      const lines = results.map((r) => {
        const trigger = `${r.trigger.type}${r.trigger.value ? `="${r.trigger.value}"` : ""}`;
        return `- **${r.id}** [${trigger}] ${r.message} _(fired ${r.fired_count}x)_`;
      });

      return ok(lines.join("\n"));
    },
  },
  {
    name: "dismiss_reminder",
    description: "Remove a reminder by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Reminder ID to dismiss" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      const id = args.id as string;
      if (!id) return err("id is required");

      const store = readStore<RemindersStore>(FILE, DEFAULT);
      const found = store.reminders.find((r) => r.id === id);
      if (!found) return err(`Reminder "${id}" not found`);

      updateStore<RemindersStore>(FILE, DEFAULT, (s) => ({
        ...s,
        reminders: s.reminders.filter((r) => r.id !== id),
      }));

      return ok(`Reminder "${id}" dismissed`);
    },
  },
];
