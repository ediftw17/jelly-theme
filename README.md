# Jelly

A theme for the Jellyfin web client. It is one stylesheet and one script: `dist/jelly.css` restyles the stock client, and `dist/jelly.js` adds a few pieces the stock client lacks, such as a Home hero, a Top 10 row and a phone tab bar. Both files are plain CSS and ES2018 with no build step. The script talks to your server only through the client's own `ApiClient`.

Written for Jellyfin 10.10 and later, including 12.x, in the default (MUI) layout, the legacy desktop layout and the mobile layout. Checked on 12.4.

## Screenshots

Screenshots will be added to `docs/screens/` (`*.png`): Home on desktop and phone, a title page, the phone player and the profile picker.

## Features

- Light, dark and auto (follows the system) modes, switched from one button in the top bar.
- Home hero: a billboard of random movies and shows with backdrops, a new set on every visit, auto-advancing.
- Top 10 row on Home. With no extra setup it ranks the signed-in user's most played movies and shows. A JSON file can set the order instead.
- Extra Home rows built from your library: collections, a director and a studio picked by day, and an "<Actor> Day" row for an actor born today.
- Badges on posters for recently added titles and new episodes.
- Title pages with a full-bleed backdrop. On phones they get Episodes, Collection and More Like This tabs and labelled action buttons.
- Phone layout: a bottom tab bar (Home, Search, My List, Profile), a large page title, library chips, a Categories sheet, Continue Watching as posters, a profile sheet, a recommended list on Search, and My List as a poster grid. My List is your Jellyfin favourites.
- Phone player: an episodes panel, a combined Audio and Subtitles panel, and double tap to skip.
- Remote and d-pad support in the desktop layouts: arrow keys move focus to the nearest item when the client does not.
- Optional, off by default:
  - "Who's watching?" profile picker for a household that shares one login.
  - Trailers that play over the hero and title pages after a short idle.
  - Avatar library: users pick a profile picture from a folder you provide.
  - Seerr (Jellyseerr or Overseerr) search and requests on the Search page.
  - Auto-update: open tabs reload when you publish new theme files.

Everything the script adds uses `nj-*` class names. Every CSS rule is scoped under `html[data-nj-theme]`, which the script sets on boot. If the script fails to load, the stock look stays.

## Install

Pick one of the three paths. Each loads the same two files.

### A. Dashboard Custom CSS plus the JavaScript Injector plugin

No server access needed.

1. Dashboard > General > Custom CSS code, add this line and save:

   ```css
   @import url("https://cdn.jsdelivr.net/gh/ediftw17/jelly-theme@main/dist/jelly.css");
   ```

2. Install the [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) plugin from its repository, restart Jellyfin, then open the plugin settings and add a script:

   ```js
   // optional: settings, see Configuration below
   window.JELLY_CONFIG = {};

   (function () {
     var s = document.createElement('script');
     s.src = 'https://cdn.jsdelivr.net/gh/ediftw17/jelly-theme@main/dist/jelly.js';
     document.head.appendChild(s);
   })();
   ```

3. Reload the web client. Clear the browser cache if the old look sticks.

Pin a release tag instead of `@main` (for example `@v0.1.0`) if you want updates only when you choose them.

If your Custom CSS also imports another full theme, such as ElegantFin, the script switches that theme off in the browser because the two fight. Remove the other import, or set `disableCustomCssThemes: false`.

### B. Reverse proxy injection

If Jellyfin sits behind nginx, the proxy can add both files to every page. Serve the files from a folder and inject the tags before `</head>`:

```nginx
server {
    server_name jellyfin.example.com;

    # the two theme files, copied to this folder
    location /jelly/ {
        alias /var/www/jelly/;
    }

    location / {
        proxy_pass http://127.0.0.1:8096;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # sub_filter needs an uncompressed body from Jellyfin
        proxy_set_header Accept-Encoding "";
        sub_filter_once on;
        sub_filter '</head>' '<link rel="stylesheet" href="/jelly/jelly.css"><script src="/jelly/jelly.js" defer></script></head>';
    }
}
```

To pass settings, add a small inline script before the theme script in the same `sub_filter` string, for example `<script>window.JELLY_CONFIG={trailers:{base:"/trailers/"}}</script>`.

### C. Self-host the two files

Download `dist/jelly.css` and `dist/jelly.js` and serve them from any web server, then point path A or B at your copies. Path A works with any URL: change the `@import` and the script `src`. Serving them from the same host as Jellyfin avoids mixed-content and CORS issues.

The stylesheet imports its two fonts from Google Fonts. To host the fonts yourself, delete the `@import` line at the top of `jelly.css` and add your own `@font-face` rules for "Bricolage Grotesque" and "Figtree".

## Configuration

Settings live in the `DEFAULTS` object at the top of `jelly.js`. You do not need to edit the file: set `window.JELLY_CONFIG` before the script loads and it is deep-merged over the defaults. Arrays replace the default array rather than merging with it.

```js
window.JELLY_CONFIG = {
  trailers: { base: '/trailers/' },
  profiles: ['Alex', ['Sam', 300], { name: 'Kids', hue: 150 }],
  household: 'family'
};
```

| Key | Default | What it does |
| --- | --- | --- |
| `themeControl` | `true` | Shows the light / dark / auto button in the top bar. |
| `disableCustomCssThemes` | `true` | Switches off other themes imported in Dashboard Custom CSS (ElegantFin and similar). Jelly's own import is never touched. |
| `hero.enabled` | `true` | Home hero billboard. |
| `hero.count` | `6` | Slides per visit. |
| `hero.intervalMs` | `9000` | Time per slide. |
| `trailers.base` | `null` | Folder with `<itemId>.mp4` clips. Off while `null`. |
| `top10.enabled` | `true` | Top 10 row on Home. |
| `top10.url` | `null` | JSON file with the ranking. While `null`, the row ranks the user's most played movies and shows, and hides itself if fewer than 3 titles have been played. |
| `top10.title` | `null` | Row title. `null` gives "Top 10", or "Top 10 this week" when `url` is set. |
| `detailBackdrop` | `true` | Full-bleed backdrop on title pages. |
| `profiles` | `[]` | Viewing profiles for the "Who's watching?" picker. The picker is off while the list is empty. |
| `household` | `''` | Name of the shared login the Household tile returns to. Used in help text only. |
| `avatars.base` | `null` | Folder for the avatar library. "Change avatar" is hidden while `null`. |
| `requests.enabled` | `false` | Seerr search and requests on the Search page. |
| `requests.base` | `'/nj-req/'` | Path of the Seerr proxy. |
| `requests.extraProfile` | `null` | `{ label, profileId }` adds a checkbox to the request dialog that requests with a second Radarr/Sonarr quality profile. |
| `autoUpdate.url` | `null` | JSON file with a version value. Off while `null`. |
| `autoUpdate.intervalMs` | `60000` | How often open tabs check it. |

With the defaults, the script makes no requests beyond the Jellyfin API and the two theme files.

## Optional extras

### Profiles

The picker is for a household that signs in with one account and wants separate watch history per person. Create a Jellyfin user for each person with an empty password, list their names in `profiles`, and sign in once as the shared account. After that, the picker opens on each new browser session and from "Switch profile" in the user menu.

Each entry is a user name, `[name, hue]` or `{ name, hue }`. The hue is an OKLCH hue from 0 to 360 for the profile's tile. Without one, the script derives a hue from the name.

Two things to know before you turn it on. Anyone who can open the web client on a signed-in device can switch to any listed profile, because those profiles have no password. And to let the Household tile switch back without a password, the script keeps the shared account's access token in the browser's localStorage under `nj-household`.

### Trailers

Put one MP4 per title in a folder your server serves on the same origin as Jellyfin, named by the Jellyfin item id:

```
/trailers/
  index.json                              optional
  0a1b2c3d4e5f60718293a4b5c6d7e8f9.mp4
  f9e8d7c6b5a4938271605f4e3d2c1b0a.mp4
```

Set `trailers.base` to `'/trailers/'`. The item id is the `id=` value in a title page's URL. A series' clip also plays on its seasons and episodes.

`index.json` is a JSON array of the item ids that have a clip. Without it the script sends one HEAD request per title to find out. Short clips (30 to 90 seconds, H.264, 1080p or lower) start fastest.

### Top 10 file

To set the ranking yourself, for example from the Playback Reporting plugin or an external chart, serve a JSON file and set `top10.url`:

```json
{
  "items": [
    { "id": "0a1b2c3d4e5f60718293a4b5c6d7e8f9", "rank": 1 },
    { "id": "f9e8d7c6b5a4938271605f4e3d2c1b0a", "rank": 2 }
  ]
}
```

Ids must be items in your library. The row shows the first 10 by rank and skips ids the signed-in user cannot see or that have no poster.

### Avatar library

Serve a folder of square PNG images, about 400 to 600 px, with an `index.json` listing the file names:

```
/avatars/
  index.json        ["fox.png", "owl.png", "robot.png"]
  fox.png
  owl.png
  robot.png
```

Set `avatars.base` to `'/avatars/'`. "Change avatar" then appears in the user menu and the phone profile sheet. A pick uploads the image as the user's Jellyfin profile picture, so every Jellyfin app shows it.

### Seerr requests

With `requests.enabled: true`, the Search page lists titles that are not in your library under the Jellyfin results, with a Request button and a "My requests" list. Posters load from `image.tmdb.org`.

The browser cannot hold your Seerr API key, so the script calls a proxy path (`requests.base`, default `/nj-req/`) on the Jellyfin host. That proxy must check the Jellyfin sign-in, add the Seerr key and forward to Seerr's `/api/v1/`. A sketch for nginx:

```nginx
location /nj-req/ {
    auth_request /nj-req-auth;
    proxy_set_header Authorization "";
    proxy_set_header X-Api-Key "<your Seerr API key>";
    proxy_pass http://127.0.0.1:5055/api/v1/;
}

location = /nj-req-auth {
    internal;
    proxy_pass http://127.0.0.1:8096/Users/Me;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Authorization $http_authorization;
}
```

Requests then reach Seerr as the owner of the API key. If you want them under each person's Seerr user, have the proxy set Seerr's `X-Api-User` header from the Jellyfin user.

### Auto-update

Serve a JSON file such as `{ "v": "2026-11-20-1" }` and set `autoUpdate.url` to it. Change the value whenever you replace the theme files. Open tabs check it every minute and reload, or wait for playback to stop and show an "Update ready" notice.

## Browser support

Current Chrome, Edge, Firefox and Safari, including Safari on iOS and the iOS home-screen web app. The stylesheet uses `oklch()`, `color-mix()` and `:has()`, so it needs Chrome or Edge 111+, Firefox 121+ or Safari 16.4+. Older browsers keep working but lose some styling.

The theme applies wherever the Jellyfin web client runs, which includes Jellyfin Media Player. Native apps that draw their own interface, such as Swiftfin or the Android TV app, do not load web themes.

## Development

There is no build step: edit the files in `dist/` and reload. `test/check.js` is a Playwright smoke check that loads both files against a real server with the default config. It needs a local `test/lib.js` that signs in to your server (see the comment at the top of `check.js`). Keep that helper and its credentials out of the repository.

## Credits

- The [Jellyfin](https://jellyfin.org) team and contributors, for the server and the web client this builds on.
- [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) by Mathieu Triay and [Figtree](https://fonts.google.com/specimen/Figtree) by Erik Kennedy, both under the SIL Open Font License, served by Google Fonts.
- The [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) plugin by n00bcodr, used by install path A.

## License

MIT. See [LICENSE](LICENSE).
