// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig, fontProviders, sessionDrivers } from "astro/config";

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
  // Self-hosted webfonts via Astro's Fonts API (DESIGN.md → Typography → Loading). Providers fetch +
  // subset at BUILD time and emit hashed, immutable /_astro/fonts/* assets served same-origin — no
  // runtime third-party request. cssVariables match the --font-* vars ymmv.css already consumes; the
  // API also generates size-matched fallback @font-face (optimizedFallbacks, on by default) to cut CLS.
  fonts: [
    {
      // Display / handle. Fontshare exclusive; a single weight (800), so a static instance is smaller
      // than the full variable file. The fontshare provider ignores `subsets` (files are already latin).
      provider: fontProviders.fontshare(),
      name: "Cabinet Grotesk",
      cssVariable: "--font-display",
      weights: [800],
      styles: ["normal"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      // Body / UI. Fontshare exposes General Sans as discrete static weights (no variable face via the
      // provider), so request exactly the three the design uses. Only 500 is preloaded (see Layout.astro).
      provider: fontProviders.fontshare(),
      name: "General Sans",
      cssVariable: "--font-sans",
      weights: [400, 500, 600],
      styles: ["normal"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      // Values / data / code. Geist Mono variable via Google, which slices the axis to the requested
      // "400 500" range -> one small variable file per subset. latin-ext preserves the old coverage.
      provider: fontProviders.google(),
      name: "Geist Mono",
      cssVariable: "--font-mono",
      weights: ["400 500"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
  adapter: cloudflare({
    // `compile` pre-optimizes images at build time, so no Cloudflare Images binding is needed.
    imageService: "compile",
  }),
});
