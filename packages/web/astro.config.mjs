// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig, fontProviders, sessionDrivers } from "astro/config";

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
  // runtime third-party request. cssVariables match the --font-* vars ymmv.css already consumes; the
  // API also generates size-matched fallback @font-face (optimizedFallbacks, on by default) to cut CLS.
  fonts: [
    {
      // Display voice: wordmark, handles, headings. Variable wght sliced to the used range -> one
      // small file. Default width only: unifont 0.7.4 drops font-stretch from Google css2 responses,
      // so a wdth-axis request would silently clamp to 100% — don't request the axis.
      provider: fontProviders.google(),
      name: "Martian Mono",
      cssVariable: "--font-display",
      weights: ["400 800"],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["ui-monospace", "monospace"],
    },
    {
      // Body / data / UI / code. Static weights on Google (no variable face), so request exactly the
      // three the design uses. Only 400@latin is preloaded (see Layout.astro).
      provider: fontProviders.google(),
      name: "IBM Plex Mono",
      cssVariable: "--font-mono",
      weights: [400, 500, 600],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-monospace", "monospace"],
    },
    {
      // Editorial voice, used sparingly (taglines/asides). Italic ONLY — every rule using
      // --font-serif must set font-style: italic or the browser synthesizes a roman.
      provider: fontProviders.google(),
      name: "Instrument Serif",
      cssVariable: "--font-serif",
      weights: [400],
      styles: ["italic"],
      subsets: ["latin"],
      fallbacks: ["Georgia", "serif"],
    },
  ],
  adapter: cloudflare({
    // `compile` pre-optimizes images at build time, so no Cloudflare Images binding is needed.
    imageService: "compile",
  }),
});
