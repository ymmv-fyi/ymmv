# Fonts

The site's fonts are fetched at build time by Astro's Fonts API (see `astro.config.mjs`) and
self-hosted from `/_astro/fonts/*` (DESIGN.md → Typography → Loading). No font files are vendored in
this repo. Attribution is retained here because the build output redistributes the fonts.

| Family | Weights | Provider | Source | License |
|---|---|---|---|---|
| Cabinet Grotesk | 800 | `fontshare()` | [Fontshare](https://www.fontshare.com/fonts/cabinet-grotesk) (Indian Type Foundry) | ITF Free Font License |
| General Sans | 400 / 500 / 600 | `fontshare()` | [Fontshare](https://www.fontshare.com/fonts/general-sans) (Indian Type Foundry) | ITF Free Font License |
| Geist Mono | 400–500 (variable, latin + latin-ext) | `google()` | [Vercel Geist](https://vercel.com/font) via [Google Fonts](https://fonts.google.com/specimen/Geist+Mono) | SIL Open Font License 1.1 |

The ITF Free Font License and the SIL OFL both permit self-hosting and redistribution as part of a
product.
