import { build } from "bun";

const result = await build({
  entrypoints: ["src/index.ts"],
  outdir: "scripts",
  naming: "mcp-server.cjs",
  target: "node",
  format: "cjs",
  minify: false,
  sourcemap: "none",
  external: [],
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

console.error("Built scripts/mcp-server.cjs");
