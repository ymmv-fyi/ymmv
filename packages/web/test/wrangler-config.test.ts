import { type ParseError, parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
// ?raw like wrangler.jsonc below: a real import would pull the adapter into workerd.
import astroConfigRaw from "../astro.config.mjs?raw";
import { canonicalHosts } from "../src/lib/canonical-origin.ts";
import { RETRY_AFTER } from "../src/lib/rate-limit.ts";
// Vite's ?raw import ships the config as a plain string into workerd (no fs there). jsonc-parser
// is the grammar wrangler itself reads the file with, so comment style can never fail this suite —
// only real structural drift can.
import wranglerRaw from "../wrangler.jsonc?raw";

interface RatelimitBinding {
  name?: string;
  namespace_id?: string;
  simple?: { limit?: number; period?: number };
}
interface Route {
  pattern?: string;
}
/** The keys that decide which origins serve a Worker. Wrangler inherits all four from the top level. */
interface OriginKeys {
  route?: unknown;
  routes?: Route[];
  workers_dev?: boolean;
  preview_urls?: boolean;
}
interface WranglerConfig extends OriginKeys {
  ratelimits?: RatelimitBinding[];
  env?: Record<string, OriginKeys & { ratelimits?: RatelimitBinding[] }>;
}

const errors: ParseError[] = [];
const config = parse(wranglerRaw, errors) as WranglerConfig;

/** The full config × binding matrix. Enumerated (not discovered) so a vanished environment or
 *  binding FAILS instead of silently shrinking the assertion set. */
const MATRIX = [
  ["top-level", "RL_WRITE"],
  ["top-level", "RL_AUTH"],
  ["production", "RL_WRITE"],
  ["production", "RL_AUTH"],
  ["staging", "RL_WRITE"],
  ["staging", "RL_AUTH"],
] as const;

function ratelimitsOf(configName: string): RatelimitBinding[] {
  if (configName === "top-level") return config.ratelimits ?? [];
  return config.env?.[configName]?.ratelimits ?? [];
}

function entryOf(configName: string, binding: string): RatelimitBinding | undefined {
  return ratelimitsOf(configName).find((r) => r.name === binding);
}

describe("wrangler.jsonc rate-limit invariants", () => {
  it("parses as JSONC", () => {
    expect(errors).toEqual([]);
    expect(config).toBeTypeOf("object");
  });

  // Not derived from any code constant: the limit is config-only, so this pin is the one thing
  // standing between a fat-fingered digit (6, 600) and a silently changed flood ceiling.
  const EXPECTED_LIMIT = 60;

  it("every (config, binding) pair exists with period === RETRY_AFTER and the expected limit", () => {
    // RETRY_AFTER is the delta-seconds hint every 429 sends; a binding whose period drifts from it
    // would tell clients to wait the wrong time while all gates stay green. If a period ever needs
    // to legitimately diverge, this failure is the prompt to introduce per-binding constants.
    for (const [configName, binding] of MATRIX) {
      const entry = entryOf(configName, binding);
      expect(entry, `${configName}/${binding} missing from wrangler.jsonc`).toBeDefined();
      expect(
        entry?.simple?.period,
        `${configName}/${binding} period drifted from RETRY_AFTER`,
      ).toBe(RETRY_AFTER);
      expect(
        entry?.simple?.limit,
        `${configName}/${binding} limit changed; update EXPECTED_LIMIT deliberately`,
      ).toBe(EXPECTED_LIMIT);
    }
  });

  it("namespace ids are pairwise distinct across dev, production, and staging", () => {
    // Rate-limit counters are shared account-wide per namespace_id: a config reusing another
    // config's id shares its LIVE counters (dev traffic consuming prod budget). Staging's comment
    // states the isolation rationale; this pins it for all three configs at once.
    const ids = MATRIX.map(([configName, binding]) => {
      const id = entryOf(configName, binding)?.namespace_id;
      expect(id, `${configName}/${binding} has no namespace_id`).toBeTypeOf("string");
      return id;
    });
    expect(new Set(ids).size).toBe(MATRIX.length);
  });
});

describe("wrangler.jsonc custom domains", () => {
  it("production routes exactly the hosts the middleware canonicalizes to an https site", () => {
    // src/middleware.ts redirects canonicalHosts(context.site) to astro.config `site`. A custom
    // domain added here but not there, or a `site` moved to www, would serve pages on a second
    // origin again; an http `site` would 301 every https visitor down to plain http.
    const site = /^\s*site:\s*"([^"]+)"/m.exec(astroConfigRaw)?.[1];
    expect(site, "no `site:` string found in astro.config.mjs").toBeDefined();
    const siteUrl = new URL(site ?? "");
    expect(siteUrl.protocol).toBe("https:");
    const patterns = (config.env?.production?.routes ?? []).map((r) => r.pattern).sort();
    expect(patterns).toEqual(canonicalHosts(siteUrl).sort());
  });

  it("production serves no workers.dev or preview URL, staging stays on workers.dev", () => {
    // Wrangler leaves an unset preview_urls out of the deploy request (the API picks the value), and
    // a Worker with preview URLs on serves every version at <version>-ymmv-production.<subdomain>.workers.dev:
    // a third origin outside canonicalHosts(). Explicit false on both keys turns them off on deploy.
    expect(config.env?.production?.workers_dev).toBe(false);
    expect(config.env?.production?.preview_urls).toBe(false);
    // Staging has no custom domain; workers.dev is its only origin. A top-level route, or the
    // production values moved up to the top level, would be inherited and take staging offline.
    const staging = config.env?.staging;
    expect(staging?.routes ?? config.routes ?? []).toEqual([]);
    expect(staging?.route ?? config.route).toBeUndefined();
    expect(staging?.workers_dev ?? config.workers_dev).not.toBe(false);
  });
});
