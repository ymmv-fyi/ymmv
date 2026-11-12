# Fonts

The site's fonts are fetched at build time by Astro's Fonts API (see `astro.config.mjs`) and
self-hosted from `/_astro/fonts/*` (DESIGN.md → Typography → Loading). No font files are vendored in
this repo. Attribution is retained here because the build output redistributes the fonts.

| Family | Weights | Provider | Source | License |
|---|---|---|---|---|
| Geist | 400–600 (variable, latin + latin-ext) | `google()` | [Vercel](https://github.com/vercel/geist-font) via [Google Fonts](https://fonts.google.com/specimen/Geist) | SIL Open Font License 1.1 |
| Geist Mono | 400–500 (variable, latin + latin-ext) | `google()` | [Vercel](https://github.com/vercel/geist-font) via [Google Fonts](https://fonts.google.com/specimen/Geist+Mono) | SIL Open Font License 1.1 |

The SIL OFL permits self-hosting and redistribution as part of a product.
