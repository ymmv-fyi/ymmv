import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

// E2E for the SSR profile/diff. The webServer builds the Worker, applies migrations + the E2E seed
// to a local D1, and runs `wrangler dev` (the real deployed artifact) — so these tests exercise the
// same code path production does. Specs are named *.e2e.ts so the Vitest *.test/*.spec globs never
// pick them up.
//
// PORT must match the `--port` in the package.json `e2e:serve` script (two places, one value).
// Every run, local or CI, starts its own server: `e2e:serve` wipes `.wrangler/state` and `dist`,
// rebuilds, re-migrates and re-seeds. `reuseExistingServer` stays off locally too — a server
// already on :8788 (a leftover `e2e:serve`, another checkout's run) serves whatever build and seed
// it started with, and reusing it tested stale code with nothing saying so. Don't turn it back on
// for speed, even though Playwright's own busy-port error suggests exactly that.
const PORT = 8788;

// Fail fast on a busy port, before Playwright's check: that one is an HTTP GET, which hangs on a
// listener that never answers, and its advice is to re-enable reuse. This probes the socket
// (both loopbacks: wrangler binds 127.0.0.1 on Windows and localhost elsewhere, a stray node
// server may take ::1) in a child so the config stays synchronous. Busy exits 2, not 1: Node
// exits 1 on any uncaught error, and a broken probe must not pass for a busy port. Workers load
// this config too, while our own server holds the port, so only the first load probes; the flag
// rides the env into every process it spawns.
const PROBE = `const net = require("net");
let pending = 2;
const free = () => --pending === 0 && process.exit(0);
for (const host of ["127.0.0.1", "::1"]) {
  const s = net.connect({ port: ${PORT}, host });
  s.on("connect", () => process.exit(2));
  s.on("error", free);
  s.setTimeout(1000, () => (s.destroy(), free()));
}`;
if (!process.env.YMMV_E2E_PORT_CHECKED) {
  process.env.YMMV_E2E_PORT_CHECKED = "1";
  try {
    execFileSync(process.execPath, ["-e", PROBE], { stdio: "ignore", timeout: 5000 });
  } catch (err) {
    if ((err as { status?: number }).status !== 2) throw err;
    // a plain message and exit: a thrown Error buries it under Playwright's config-loader stack
    console.error(
      `Port ${PORT} is already in use. The e2e suite serves its own fresh build there and never ` +
        "reuses a running server, which would test that server's old build and seed. Stop " +
        "whatever holds the port (a leftover `e2e:serve`, another checkout's e2e run) and rerun. " +
        "On Windows, end the `wrangler dev` node process too, or it restarts workerd on the port.",
    );
    process.exit(1);
  }
}

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
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
