/// <reference types="@cloudflare/vitest-pool-workers" />

// `env` from "cloudflare:test" is typed as Cloudflare.Env. The `src` build gets full bindings from
// the generated worker-configuration.d.ts; tests are excluded from `astro check`, so we declare the
// bindings they touch here: the D1 `DB` plus TEST_MIGRATIONS (injected from vitest.config.ts and
// consumed by test/apply-migrations.ts). The structural shape matches cloudflare:test's D1Migration.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RL_WRITE: RateLimit;
    RL_AUTH: RateLimit;
    GITHUB_CLIENT_SECRET: string;
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
