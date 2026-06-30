import { defineConfig, devices } from "@playwright/test";

// E2E for the SSR profile/diff. The webServer builds the Worker, applies migrations + the E2E seed
// to a local D1, and runs `wrangler dev` (the real deployed artifact) — so these tests exercise the
// same code path production does. Specs are named *.e2e.ts so the Vitest *.test/*.spec globs never
// pick them up.
//
// PORT must match the `--port` in the package.json `e2e:serve` script (two places, one value).
// Locally `reuseExistingServer` reuses an already-running :8788 for speed — but a server left from a
// PRIOR run serves its OLD build/seed, so kill it after editing src or seed.sql. A cold run (CI, or
// nothing on :8788) always wipes `.wrangler/state`, rebuilds, re-migrates and re-seeds first.
const PORT = 8788;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm run e2e:serve",
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
