import { randomBytes } from "crypto";

/** Generate a short prefixed ID: "rem_a1b2c3d4" */
export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/** ISO 8601 timestamp */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Build a successful MCP text result */
export function ok(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

/** Build an error MCP result */
export function err(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text" as const, text }], isError: true };
}
