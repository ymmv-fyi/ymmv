import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs tests inside workerd via @cloudflare/vitest-pool-workers (0.16 plugin API). Bindings (the
// D1 `DB`) come from wrangler.jsonc; miniflare backs D1 with throwaway SQLite. Tracked migrations
// are read on the Node side (readD1Migrations) and injected as a binding, then applied per-suite in
// test/apply-migrations.ts.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Test-only fake — the real secret is a Worker secret set via `wrangler secret put`. Its
          // presence lets the mint handler pass its fail-closed guard and reach introspection (which
          // tests stub). GITHUB_CLIENT_ID is a compile-time @ymmv/shared constant, so it needs no binding.
          GITHUB_CLIENT_SECRET: "test-client-secret",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
}));
