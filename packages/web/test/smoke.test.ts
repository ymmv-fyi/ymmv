import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// Smoke test: proves the @cloudflare/vitest-pool-workers harness boots and the D1
// binding resolves against miniflare's local SQLite.
it("exposes the D1 binding and runs a query", async () => {
  const row = await env.DB.prepare("SELECT 1 AS n").first<{ n: number }>();
  expect(row?.n).toBe(1);
});
