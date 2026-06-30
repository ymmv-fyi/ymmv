// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig, sessionDrivers } from "astro/config";

// One unified Cloudflare Worker (Astro 7 + @astrojs/cloudflare 14): SSR site + API + static
// assets, one D1 binding. The real /[handle] profile + 3-column diff UI (per DESIGN.md) lives here.
export default defineConfig({
  output: "server",
  // Bearer-token API, no cookies = no CSRF surface. Astro's default checkOrigin 403s the CLI
  // (it sends no Origin header), so turn it off.
  security: { checkOrigin: false },
  // We use no Astro sessions. The adapter otherwise defaults sessions to a Cloudflare KV binding
  // ("SESSION") and auto-provisions it on deploy — which our scoped API token can't do (no KV perms).
  // A non-KV (in-memory) driver suppresses that binding. `sessionDrivers.memory()` is the Astro 7
  // object signature that replaces the deprecated `{ driver: "memory" }` string form.
  session: { driver: sessionDrivers.memory() },
  adapter: cloudflare({
    // `compile` pre-optimizes images at build time, so no Cloudflare Images binding is needed.
    imageService: "compile",
  }),
});
