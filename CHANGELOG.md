# Changelog

## 0.1.0 (2026-11-20)

First public release.

- `dist/jelly.css`: the full theme, scoped under `html[data-nj-theme]`, with light, dark and auto modes. Fonts load from Google Fonts.
- `dist/jelly.js`: Home hero, Top 10 row (built from play counts, or from a JSON file), library-based Home rows, poster badges, title-page backdrop and phone tabs, phone tab bar and player panels, d-pad fallback.
- Optional features, all off by default: "Who's watching?" profiles, trailers, avatar library, Seerr requests through a proxy, auto-update.
- Configuration through `window.JELLY_CONFIG`, deep-merged over the defaults.
- `test/check.js`: Playwright smoke check for the default config.
