# Fonts

The site's fonts are fetched at build time by Astro's Fonts API (see `astro.config.mjs`) and
self-hosted from `/_astro/fonts/*` (DESIGN.md → Typography → Loading). No font files are vendored in
this repo. Attribution is retained here because the build output redistributes the fonts.

| Family | Weights | Provider | Source | License |
|---|---|---|---|---|
| Martian Mono | 400–800 (variable, latin) | `google()` | [Evil Martians](https://github.com/evilmartians/mono) via [Google Fonts](https://fonts.google.com/specimen/Martian+Mono) | SIL Open Font License 1.1 |
| IBM Plex Mono | 400 / 500 / 600 (latin + latin-ext) | `google()` | [IBM Plex](https://github.com/IBM/plex) via [Google Fonts](https://fonts.google.com/specimen/IBM+Plex+Mono) | SIL Open Font License 1.1 |
| Instrument Serif | 400 italic (latin) | `google()` | [Instrument](https://github.com/Instrument/instrument-serif) via [Google Fonts](https://fonts.google.com/specimen/Instrument+Serif) | SIL Open Font License 1.1 |

The SIL OFL permits self-hosting and redistribution as part of a product.
