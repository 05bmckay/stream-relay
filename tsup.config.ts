import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    client: "packages/client/index.ts",
    server: "packages/server/index.ts",
    worker: "packages/worker/index.ts",
    hono: "packages/hono/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Worker entry is ESM-only (CJS doesn't make sense for Workers).
  // tsup will still emit cjs but Workers users won't import it.
  external: ["react", "hono", "cloudflare:workers"],
});
