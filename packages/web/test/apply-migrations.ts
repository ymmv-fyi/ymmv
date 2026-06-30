import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply tracked D1 migrations once before each test file. TEST_MIGRATIONS is injected from
// vitest.config.ts (readD1Migrations → miniflare binding). With isolated storage the migrations
// seed the base layer visible to every test, while each test's own writes roll back between tests.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
