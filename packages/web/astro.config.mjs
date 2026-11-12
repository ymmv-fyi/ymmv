// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig, fontProviders, sessionDrivers } from "astro/config";
import typegpu from "unplugin-typegpu/vite";

// One unified Cloudflare Worker (Astro 7 + @astrojs/cloudflare 14): SSR site + API + static
// assets, one D1 binding. The real /[handle] profile + 3-column diff UI (per DESIGN.md) lives here.
export default defineConfig({
  output: "server",
  // Canonical origin — used to absolutize social-card URLs (og:image must not be relative).
  site: "https://ymmv.fyi",
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
  // runtime third-party request. The API also generates size-matched fallback @font-face
  // (optimizedFallbacks, on by default) to cut CLS.
  fonts: [
    {
      // The site's voice: headings, body, UI. Variable wght, sliced to the range the design uses.
      provider: fontProviders.google(),
      name: "Geist",
      cssVariable: "--font-sans",
      weights: ["400 600"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["system-ui", "sans-serif"],
    },
    {
      // Commands, transcripts, code and the readout's small labels.
      provider: fontProviders.google(),
      name: "Geist Mono",
      cssVariable: "--font-mono",
      weights: ["400 500"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
  ],
  // The landing's hero animation is TypeGPU: the plugin compiles its 'use gpu' functions to WGSL.
  vite: {
    plugins: [typegpu()],
  },
  adapter: cloudflare({
    // `compile` pre-optimizes images at build time, so no Cloudflare Images binding is needed.
    imageService: "compile",
  }),
});
