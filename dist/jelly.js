/* Jelly: a theme and small runtime for the stock Jellyfin web client (10.10+ and 12.x).
   https://github.com/ediftw17/jelly-theme  (MIT)
   Plain ES2018, no build step. Talks to the server only through the page's own
   window.ApiClient. Optional extras (trailers, a Top 10 file, an avatar library,
   Seerr requests, auto-update) make extra same-origin requests only when you
   turn them on in the config below.
   Adds: theme button, Home hero, idle trailer with a sound toggle, Top 10 row,
   detail-page backdrop, "Who's watching?" profile picker, phone tab bar and
   player panels, d-pad fallback. Everything it injects is nj-*.
   Pair it with jelly.css: the stylesheet does nothing until this script sets
   html[data-nj-theme]. */
(function () {
  'use strict';

  /* ============ CONFIG ============
     Edit the defaults here, or leave this file alone and set window.JELLY_CONFIG
     before the script loads. JELLY_CONFIG is deep-merged over the defaults
     (arrays replace, they do not merge). Example:
       window.JELLY_CONFIG = { trailers: { base: '/trailers/' }, profiles: ['Alex', 'Sam'] };
     Every default works on a stock server with no extra files. */
  var IDLE_MS = 2500;          // idle time on Home before the hero trailer starts
  var DEFAULTS = {
    themeControl: true,        // light / dark / auto button in the top bar
    // A Custom CSS theme @imported in Dashboard > General > Custom CSS (ElegantFin and
    // similar) fights this one. When true, those <style> blocks are switched off in the
    // browser. Jelly's own @import is never touched.
    disableCustomCssThemes: true,
    hero: {
      enabled: true,
      count: 6,                // slides: random movies/series with a backdrop, new set every visit
      intervalMs: 9000         // auto-advance
    },
    // Trailer clips for the hero and title pages. Off while base is null.
    // Set base to a same-origin folder that holds <itemId>.mp4 files, e.g. '/trailers/'.
    // An optional <base>index.json (array of item ids) saves one HEAD request per title.
    trailers: { base: null },
    // Top 10 row on Home. With url null it is built from the server: the signed-in
    // user's most played movies and shows. With a url, that JSON file sets the order:
    // { "items": [ { "id": "<itemId>", "rank": 1 }, ... ] }.
    top10: { enabled: true, url: null, title: null }, // title null: "Top 10" (or "Top 10 this week" with a url)
    detailBackdrop: true,
    // "Who's watching?" picker. Off while the list is empty. Each entry is a Jellyfin
    // user name, or [name, hue] / { name, hue } with an OKLCH hue (0-360) for its tile.
    // Profiles sign in with an empty password. `household` is the shared login the
    // Household tile returns to (shown in help text only).
    profiles: [],
    household: '',
    // "Change avatar" in the user menu. Off while base is null. Set base to a
    // same-origin folder with index.json (array of PNG file names) and the PNGs.
    avatars: { base: null },
    // Seerr (Jellyseerr / Overseerr) search and requests on the Search page. Needs a
    // reverse proxy at `base` that checks the Jellyfin sign-in and adds the Seerr API
    // key: see the README. extraProfile adds a checkbox that requests with a second
    // Radarr/Sonarr quality profile: { label: 'Original audio', profileId: 7 }.
    requests: { enabled: false, base: '/nj-req/', extraProfile: null },
    // Reload open tabs when the theme files change. Off while url is null. The url
    // returns { "v": "<any string that changes with each release>" }.
    autoUpdate: { url: null, intervalMs: 60000 }
  };
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function merge(base, over) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    if (!isObj(over)) return out;
    for (k in over) out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    return out;
  }
  var NJ = merge(DEFAULTS, window.JELLY_CONFIG);
  // profiles as [name, hue]; a missing hue comes from the name and skips amber (60-95), the focus colour
  function nameHue(n) {
    var h = 0;
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) | 0;
    h = Math.abs(h) % 325;
    return h >= 60 ? h + 35 : h;
  }
  var PROFILES = (Array.isArray(NJ.profiles) ? NJ.profiles : []).map(function (p) {
    var n = Array.isArray(p) ? p[0] : isObj(p) ? p.name : p, hue = Array.isArray(p) ? p[1] : isObj(p) ? p.hue : null;
    n = n == null ? '' : String(n).trim();
    return n ? [n, typeof hue === 'number' ? hue : nameHue(n)] : null;
  }).filter(Boolean);
  var PROFILES_ON = PROFILES.length > 0;
  var HOUSEHOLD = String(NJ.household || '');
  function slash(b) { return b ? String(b).replace(/\/?$/, '/') : null; }
  var TRAILERS = slash(NJ.trailers && NJ.trailers.base);
  var AVATARS = slash(NJ.avatars && NJ.avatars.base);
  var REQ_BASE = slash(NJ.requests && NJ.requests.base) || '/nj-req/';

  var root = document.documentElement;
  if (root.getAttribute('data-nj-v') === '3') return; // loaded twice: do nothing
  root.setAttribute('data-nj-v', '3');

  /* ============ HELPERS ============ */
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  // jellyfin-web saves a library's A-Z letter and its filters (Favorites, Played...) under
  // "<view> - <libraryId>", shared by every profile in this browser, and applies them on
  // every later visit ("Nothing here"). Start each load unfiltered; sort and view stay.
  (function clearSavedLibraryFilters() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i), v = localStorage.getItem(k);
        if (!v || !/"(Alphabet|NameStartsWith|NameLessThan|Filters)"/.test(v)) continue;
        var o = JSON.parse(v);
        if (!o || typeof o !== 'object') continue;
        delete o.Alphabet; delete o.NameStartsWith; delete o.NameLessThan; delete o.Filters;
        localStorage.setItem(k, JSON.stringify(o));
      }
    } catch (e) { /* storage blocked or not JSON */ }
  })();

  function mq(q) { return window.matchMedia ? window.matchMedia(q) : { matches: false }; }
  function onMq(m, fn) { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); }
  var sysDark = mq('(prefers-color-scheme: dark)');
  var reduced = mq('(prefers-reduced-motion: reduce)');

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function visible(el) { return !!(el && el.isConnected && el.offsetParent !== null); }
  function api() { return window.ApiClient; }
  function userId() { var a = api(); return a && a.getCurrentUserId ? a.getCurrentUserId() : null; }
  function imageUrl(id, type, tag, w) { return api().getImageUrl(id, { type: type, tag: tag, maxWidth: w, quality: 85 }); }
  function detailsHash(id) {
    var a = api();
    return '#/details?id=' + encodeURIComponent(id) + (a && a.serverId ? '&serverId=' + encodeURIComponent(a.serverId()) : '');
  }
  // the visible top bar: MUI app bar (12.x default) or the legacy .skinHeader
  function headerEl() {
    var list = document.querySelectorAll('header.MuiAppBar-root, .skinHeader');
    for (var i = 0; i < list.length; i++) if (list[i].getBoundingClientRect().height > 0) return list[i];
    return null;
  }
  function backdropOf(it, w) {
    if (it.BackdropImageTags && it.BackdropImageTags.length) return imageUrl(it.Id, 'Backdrop', it.BackdropImageTags[0], w);
    if (it.ParentBackdropImageTags && it.ParentBackdropImageTags.length) return imageUrl(it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags[0], w);
    return '';
  }

  var ICON = {
    play: '<svg class="nj-ico nj-ico--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
    info: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
    star: '<svg class="nj-ico nj-ico--fill" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>',
    left: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6"/></svg>',
    right: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>',
    auto: '<svg class="nj-ico nj-m nj-m-auto" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 0 0-16z" fill="currentColor" stroke="none"/></svg>',
    sun: '<svg class="nj-ico nj-m nj-m-light" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
    moon: '<svg class="nj-ico nj-m nj-m-dark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    mute: '<svg class="nj-ico nj-i-mute" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
    vol: '<svg class="nj-ico nj-i-vol" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    lock: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
    home: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 10.2 12 4.2l7.5 6V19a1 1 0 0 1-1 1H15v-5.5H9V20H5.5a1 1 0 0 1-1-1z"/></svg>',
    swap: '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M17 5h4.5M19.5 3l2 2-2 2M21.5 12H17M19 10l-2 2 2 2"/></svg>'
  };

  function minutesLabel(ticks) {
    var m = Math.round(ticks / 6e8);
    if (!m) return '';
    var h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function metaHtml(it) {
    var bits = [];
    if (it.CommunityRating) bits.push('<span class="nj-star">' + ICON.star + it.CommunityRating.toFixed(1) + '</span>');
    if (it.ProductionYear) bits.push('<span>' + it.ProductionYear + '</span>');
    if (it.OfficialRating) bits.push('<span class="nj-rated">' + esc(it.OfficialRating) + '</span>');
    if (it.Type === 'Series' && it.ChildCount) bits.push('<span>' + it.ChildCount + (it.ChildCount === 1 ? ' season' : ' seasons') + '</span>');
    else if (it.RunTimeTicks) bits.push('<span>' + minutesLabel(it.RunTimeTicks) + '</span>');
    if (it.Genres && it.Genres.length) bits.push('<span class="nj-g">' + esc(it.Genres.slice(0, 2).join(' / ')) + '</span>');
    return '<p class="nj-meta">' + bits.join('') + '</p>';
  }
  function progress(it) {
    var u = it.UserData;
    if (!u || !u.PlaybackPositionTicks || !it.RunTimeTicks) return null;
    return { p: Math.min(1, u.PlaybackPositionTicks / it.RunTimeTicks), left: minutesLabel(it.RunTimeTicks - u.PlaybackPositionTicks) };
  }

  var ITEMS = {};
  function getItem(id) {
    if (!ITEMS[id]) ITEMS[id] = api().getItem(userId(), id).catch(function (e) { delete ITEMS[id]; throw e; });
    return ITEMS[id];
  }

  /* Play = open the item page, then press its own Play button once it renders.
     Jellyfin's playback manager is not a global, so this reuses its UI. Pages
     that existed before the click are marked so a stale one is never pressed. */
  var pendingPlay = null;
  function play(id) {
    each(document.querySelectorAll('.itemDetailPage'), function (p) { p.setAttribute('data-nj-seen', '1'); });
    pendingPlay = { id: id, until: Date.now() + 8000 };
    location.hash = detailsHash(id);
  }
  function tryPendingPlay() {
    if (!pendingPlay) return;
    if (Date.now() > pendingPlay.until || location.hash.indexOf(pendingPlay.id) < 0) { pendingPlay = null; return; }
    var page = document.querySelector('.itemDetailPage:not(.hide):not([data-nj-seen])');
    var btn = page && page.querySelector('.btnPlay:not(.hide)');
    if (btn && visible(btn)) { pendingPlay = null; btn.click(); }
  }

  /* ============ CUSTOM CSS THEMES (Dashboard) ============ */
  var THEME_IMPORT = /@import[^;]*(ElegantFin|jellyfin-theme|cdn\.jsdelivr\.net\/gh\/)/i;
  var JELLY_IMPORT = /jelly-theme|jelly\.css/i;
  function disableCustomCssThemes() {
    if (!NJ.disableCustomCssThemes) return;
    each(document.querySelectorAll('style:not([data-nj-off])'), function (s) {
      if (THEME_IMPORT.test(s.textContent) && !JELLY_IMPORT.test(s.textContent)) { s.setAttribute('data-nj-off', '1'); s.disabled = true; if (s.sheet) s.sheet.disabled = true; }
    });
  }

  /* ============ THEME: auto / light / dark, one button ============ */
  var MODES = ['auto', 'light', 'dark'];
  var MODE_LABEL = { auto: 'Auto (follows your system)', light: 'Light', dark: 'Dark' };
  function themePref() { var t = store.get('nj-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; }
  function applyTheme() {
    var t = themePref();
    var next = MODES[(MODES.indexOf(t) + 1) % MODES.length];
    root.setAttribute('data-nj-theme', t);
    root.setAttribute('data-nj-eff', t === 'auto' ? (sysDark.matches ? 'dark' : 'light') : t);
    each(document.querySelectorAll('.nj-theme-btn'), function (b) {
      var label = 'Theme: ' + MODE_LABEL[t] + '. Switch to ' + MODE_LABEL[next].split(' ')[0];
      b.setAttribute('aria-label', label);
      b.title = label;
    });
  }
  applyTheme();
  onMq(sysDark, applyTheme);

  function themeButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nj-theme-btn';
    b.setAttribute('data-nj-do', 'theme');
    b.innerHTML = ICON.auto + ICON.sun + ICON.moon;
    return b;
  }
  /* ============ PHONE TAB BAR ============
     Home, Movies, Shows, Music, Search along the bottom, like the phone apps. Only in
     Jellyfin's mobile layout, signed in, and never over the player or the profile picker.
     Library links come from the user's own views, so ids are never hard-coded. */
  var TABS = { el: null, views: null, list: null, asked: false };
  var TAB_ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.8 12 3.5l8.5 7.3V20a.5.5 0 0 1-.5.5h-4.5v-6h-7v6H4a.5.5 0 0 1-.5-.5z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2-6.5 4.2v-16a1 1 0 0 1 1-1z"/></svg>',
    me: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5c.8-3.9 3.7-6 7.5-6s6.7 2.1 7.5 6"/></svg>'
  };
  function isHome(h) { return (h === '' || h === '#' || h === '#/' || /^#\/home(\?|$)/.test(h)) && !/[?&]tab=1\b/.test(h); }
  function isMyList(h) { return /^#\/home\?(.*&)?tab=1\b/.test(h); }
  function tabLinks() {
    return [
      { k: 'home', t: 'Home', h: '#/home', m: isHome },
      { k: 'search', t: 'Search', h: '#/search', m: function (h) { return /^#\/search/.test(h); } },
      { k: 'list', t: 'My List', h: '#/home?tab=1', m: isMyList },
      { k: 'me', t: 'Profile', m: function () { return false; } }
    ];
  }
  function headerAvatarSrc() {
    var im = document.querySelector('header.MuiAppBar-root .MuiAvatar-root img');
    return im ? im.getAttribute('src') : '';
  }
  function ensureTabBar() {
    var a = window.ApiClient, hash = location.hash || '';
    var on = root.classList.contains('layout-mobile') && a && a.getCurrentUserId && a.getCurrentUserId() &&
      !/^#\/(video|login|selectserver|wizard|startup|queue|configurationpage)/.test(hash) &&
      !root.classList.contains('nj-who-open') && !document.querySelector('.videoPlayerContainer:not(.hide)');
    if (!on) {
      if (TABS.el) { TABS.el.remove(); TABS.el = null; }
      root.classList.remove('nj-tabs-on');
      ensureChips(false);
      root.classList.remove('nj-back-on');
      return;
    }
    if (!TABS.list && !TABS.asked) {
      TABS.asked = true;
      a.getJSON(a.getUrl('UserViews', { userId: a.getCurrentUserId() })).then(function (r) {
        var skip = { playlists: 1, boxsets: 1, livetv: 1, folders: 1 };
        TABS.list = (r.Items || []).filter(function (i) { return !skip[i.CollectionType || 'folders']; });
        ensureChips(true);
      }).catch(function () { TABS.list = []; });
    }
    var links = tabLinks(), av = headerAvatarSrc(), sig = links.map(function (l) { return l.k; }).join() + '|' + av;
    if (!TABS.el || TABS.el.getAttribute('data-sig') !== sig) {
      if (TABS.el) TABS.el.remove();
      var nav = document.createElement('nav');
      nav.className = 'nj-tabs';
      nav.setAttribute('aria-label', 'Main');
      nav.setAttribute('data-sig', sig);
      nav.innerHTML = links.map(function (l) {
        if (l.k === 'me') {
          var pic = av ? '<img class="nj-tab-av" alt="" src="' + esc(av) + '">' : TAB_ICON.me;
          return '<button type="button" class="nj-tab" data-k="me" data-nj-do="me">' + pic + '<span>' + l.t + '</span></button>';
        }
        return '<a class="nj-tab" href="' + esc(l.h) + '" data-k="' + l.k + '">' + TAB_ICON[l.k] + '<span>' + l.t + '</span></a>';
      }).join('');
      document.body.appendChild(nav);
      TABS.el = nav;
    }
    each(TABS.el.children, function (c, i) {
      if (links[i].m(hash)) c.setAttribute('aria-current', 'page'); else c.removeAttribute('aria-current');
    });
    root.classList.add('nj-tabs-on');
    root.classList.toggle('nj-mylist', isMyList(hash));
    ensureChips(true);
    ensureBack(hash);
  }

  // a back button in the top-left corner on every page that is not a tab (title pages, genres, people, libraries)
  function ensureBack(hash) {
    var bar = document.querySelector('header.MuiAppBar-root .MuiToolbar-root');
    if (!bar) return;
    var b = bar.querySelector('.nj-back');
    var want = !(isHome(hash) || isMyList(hash) || /^#\/search/.test(hash));
    if (!want) { if (b) b.remove(); root.classList.remove('nj-back-on'); return; }
    if (!b) {
      b = document.createElement('button');
      b.type = 'button'; b.className = 'nj-back'; b.setAttribute('aria-label', 'Back'); b.setAttribute('data-nj-do', 'back');
      b.innerHTML = '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>';
      bar.insertBefore(b, bar.firstChild);
    }
    root.classList.add('nj-back-on');
  }

  /* ============ PHONE PAGE TITLE + LIBRARY CHIPS ============
     A big page title in the top bar, and on Home a row of library chips under it
     (Shows, Movies, Music, YouTube...), built from the user's own libraries. */
  function viewHref(v) {
    var t = v.CollectionType, id = v.Id;
    if (t === 'movies') return '#/movies?topParentId=' + id + '&collectionType=movies';
    if (t === 'tvshows') return '#/tv?topParentId=' + id + '&collectionType=tvshows';
    if (t === 'music') return '#/music?topParentId=' + id + '&collectionType=music';
    return '#/list?parentId=' + id + (t ? '&collectionType=' + t : '');
  }
  function pageTitle(h) {
    if (isHome(h)) return 'Home';
    if (isMyList(h)) return 'My List';
    if (/^#\/search/.test(h)) return 'Search';
    var m = /[?&](?:topParentId|parentId)=([0-9a-f]+)/i.exec(h), name = '';
    if (m && TABS.list) each(TABS.list, function (v) { if (v.Id === m[1]) name = v.Name; });
    return name;
  }
  function ensureChips(on) {
    var head = document.querySelector('header.MuiAppBar-root');
    if (!head) return;
    var hash = location.hash || '', bar = head.querySelector('.MuiToolbar-root');
    var tt = bar && bar.querySelector('.nj-ptitle'), t = on ? pageTitle(hash) : '';
    if (!t || !bar) { if (tt) tt.remove(); }
    else {
      if (!tt) {
        tt = document.createElement('h1');
        tt.className = 'nj-ptitle';
      }
      // the menu button can render after the title was placed: keep the title right after it
      var hb = bar.querySelector('[aria-label="Open Menu"]');
      if (hb && hb.nextSibling !== tt) hb.parentNode.insertBefore(tt, hb.nextSibling);
      else if (!hb && !tt.parentNode) bar.insertBefore(tt, bar.firstChild);
      if (tt.textContent !== t) tt.textContent = t;
    }
    var c = head.querySelector('.nj-chips');
    var want = on && isHome(hash) && TABS.list && TABS.list.length;
    if (!want) { if (c) c.remove(); root.classList.remove('nj-chips-on'); return; }
    if (c) return;
    // first Shows, Movies and Music library in that order, then the rest as the server lists them
    var order = { tvshows: 0, movies: 1, music: 2 }, seen = {};
    var views = TABS.list.map(function (v, i) {
      var t = v.CollectionType, k = (t in order && !seen[t]) ? order[t] : 10 + i;
      seen[t] = 1;
      return { v: v, k: k };
    }).sort(function (x, y) { return x.k - y.k; }).map(function (x) { return x.v; });
    c = document.createElement('nav');
    c.className = 'nj-chips';
    c.setAttribute('aria-label', 'Libraries');
    c.innerHTML = views.map(function (v) { return '<a class="nj-chip" href="' + esc(viewHref(v)) + '">' + esc(v.Name) + '</a>'; }).join('') +
      '<button type="button" class="nj-chip nj-chip--cat" data-nj-do="cats">Categories<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>';
    head.appendChild(c);
    root.classList.add('nj-chips-on');
  }


  /* ============ PHONE PROFILE SHEET ============
     The Profile tab opens a sheet: the current profile large, the other profiles in a row
     (one tap switches, through the "Who's watching?" picker), then the menu. Menu rows run
     Jellyfin's own user-menu entries, so Settings, Dashboard and Sign Out behave as before. */
  function profAvatar(name, cls) {
    var k = known()[name] || {}, a = api(), hue = profileHue(name);
    var img = k.tag && a && a.getUserImageUrl ? '<img alt="" src="' + esc(a.getUserImageUrl(k.id, { type: 'Primary', tag: k.tag, maxWidth: 240 })) + '">' : '';
    return '<span class="' + cls + '" style="--nj-h:' + (hue == null ? 250 : hue) + '"><span aria-hidden="true">' + esc(initialOf(name)) + '</span>' + img + '</span>';
  }
  function profOpen() {
    var a = api();
    if (!a) return;
    cwClose();
    Promise.resolve(a.getCurrentUser()).then(function (me) {
      var name = me ? me.Name : '', admin = !!(me && me.Policy && me.Policy.IsAdministrator);
      var others = PROFILES.map(function (p) { return p[0]; }).filter(function (n) { return n.toLowerCase() !== name.toLowerCase(); });
      var row = function (act, label, icon) { return '<button type="button" class="nj-sheet-i" data-nj-do="prof-go" data-nj-id="' + act + '">' + icon + '<span>' + label + '</span></button>'; };
      var I = function (d) { return '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>'; };
      var el = document.createElement('div');
      el.className = 'nj-sheet nj-sheet--prof';
      el.innerHTML = '<div class="nj-sheet-bd" data-nj-do="cw-close"></div><div class="nj-sheet-in nj-prof" role="dialog" aria-label="Profiles">' +
        '<div class="nj-prof-top"><p class="nj-prof-t">Profiles</p><button type="button" class="nj-prof-x" data-nj-do="cw-close" aria-label="Close">' + I('M6 6l12 12M18 6 6 18') + '</button></div>' +
        '<div class="nj-prof-me">' + profAvatar(name, 'nj-prof-av nj-prof-av--me') + '<p class="nj-prof-n">' + esc(name) + '</p>' +
          (AVATARS ? '<button type="button" class="nj-prof-edit" data-nj-do="avatar-open" aria-label="Change avatar">' + I('M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4') + '</button>' : '') + '</div>' +
        (others.length ? '<div class="nj-prof-others">' + others.map(function (n) {
          return '<button type="button" class="nj-prof-o" data-nj-do="prof-switch" data-nj-id="' + esc(n) + '">' + profAvatar(n, 'nj-prof-av') + '<span>' + esc(n) + '</span></button>';
        }).join('') + '</div>' : '') +
        '<div class="nj-prof-menu">' +
          row('theme', 'Light / dark', I('M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18')) +
          row('Settings', 'App Settings', I('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z')) +
          row('Profile', 'Account', I('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c.8-4 3.9-6 8-6s7.2 2 8 6')) +
          (admin ? row('Dashboard', 'Server dashboard', I('M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z')) : '') +
          row('Sign Out', 'Sign Out', I('M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10')) +
        '</div></div>';
      document.body.appendChild(el);
      CW.sheet = el;
    });
  }
  // run one of Jellyfin's user-menu entries without showing that menu
  function profGo(which) {
    cwClose();
    if (which === 'theme') { var tb = document.querySelector('.nj-theme-btn:not(.nj-homebtn)'); if (tb) tb.click(); return; }
    var um = document.querySelector('header.MuiAppBar-root [aria-label="User Menu"]');
    if (!um) return;
    root.classList.add('nj-menu-proxy');
    um.click();
    var tries = 0;
    (function pick() {
      var items = document.querySelectorAll('#app-user-menu [role="menuitem"]'), hit = null;
      each(items, function (i) { if (!hit && i.textContent.trim() === which) hit = i; });
      if (hit) {
        hit.click();
        setTimeout(function () {
          var bd = document.querySelector('#app-user-menu .MuiBackdrop-root');
          if (bd) bd.click();
          setTimeout(function () { root.classList.remove('nj-menu-proxy'); }, 300);
        }, 150);
      }
      else if (++tries < 30) setTimeout(pick, 50);
      else root.classList.remove('nj-menu-proxy');
    })();
  }
  function profSwitch(name) {
    cwClose();
    whoOpen();
    var tries = 0;
    (function pick() {
      var b = WHO.el && WHO.el.querySelector('.nj-who-p[data-nj-name="' + name.replace(/"/g, '') + '"]');
      if (b) b.click(); else if (++tries < 40) setTimeout(pick, 50);
    })();
  }

  /* ============ PHONE SEARCH: "Recommended" list before typing ============ */
  var SR = { items: null, asked: false };
  function syncSearch() {
    if (!root.classList.contains('layout-mobile') || !/^#\/search/.test(location.hash)) return;
    var sug = document.querySelector('.page:not(.hide) .searchSuggestions');
    if (!sug || sug.parentNode.querySelector(':scope > .nj-srch')) return;
    if (!SR.items && !SR.asked) {
      SR.asked = true;
      var a = api(), u = userId();
      if (!a || !u) return;
      a.getItems(u, { Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'Random', Limit: 24, ImageTypes: 'Backdrop', EnableImageTypes: 'Backdrop,Thumb,Primary', ImageTypeLimit: 1 })
        .then(function (r) { SR.items = (r && r.Items) || []; schedule(); }, function () { SR.items = []; });
      return;
    }
    if (!SR.items || !SR.items.length) return;
    var el = document.createElement('div');
    el.className = 'nj-srch';
    el.innerHTML = '<h2 class="nj-srch-t">Recommended TV Shows &amp; Movies</h2><ul>' + SR.items.map(function (it) {
      var bd = it.BackdropImageTags && it.BackdropImageTags[0];
      var img = it.ImageTags && it.ImageTags.Thumb ? imageUrl(it.Id, 'Thumb', it.ImageTags.Thumb, 400) : bd ? imageUrl(it.Id, 'Backdrop', bd, 400) : '';
      return '<li><a class="nj-srch-i" href="' + esc(detailsHash(it.Id)) + '"><span class="nj-srch-img">' + (img ? '<img alt="" loading="lazy" src="' + esc(img) + '">' : '') + '</span>' +
        '<span class="nj-srch-n">' + esc(it.Name) + '</span>' +
        '<button type="button" class="nj-srch-p" data-nj-do="play" data-nj-id="' + esc(it.Id) + '" aria-label="Play ' + esc(it.Name) + '"></button></a></li>';
    }).join('') + '</ul>';
    sug.parentNode.insertBefore(el, sug);
    var inp = sug.parentNode.querySelector('.searchfields-txtSearch');
    var sync = function () { el.classList.toggle('nj-srch--off', !!(inp && inp.value.trim())); };
    if (inp) inp.addEventListener('input', sync);
    sync();
  }
  /* Categories chip: a sheet of genres (films and shows together) */
  function catsOpen() {
    var a = api(), u = userId();
    if (!a || !u) return;
    cwClose();
    var el = document.createElement('div');
    el.className = 'nj-sheet nj-sheet--cats';
    el.innerHTML = '<div class="nj-sheet-bd" data-nj-do="cw-close"></div><div class="nj-sheet-in nj-cats" role="dialog" aria-label="Categories"><p class="nj-cats-t">Categories</p><div class="nj-cats-list"></div>' +
      '<button type="button" class="nj-sheet-i nj-sheet-cancel" data-nj-do="cw-close"><span>Close</span></button></div>';
    document.body.appendChild(el);
    CW.sheet = el;
    a.getJSON(a.getUrl('Genres', { userId: u, IncludeItemTypes: 'Movie,Series', Recursive: true })).then(function (r) {
      el.querySelector('.nj-cats-list').innerHTML = ((r && r.Items) || []).map(function (g) {
        return '<a class="nj-sheet-i" data-nj-do="cw-close" href="#/list?genreId=' + esc(g.Id) + '&serverId=' + esc(a.serverId()) + '"><span>' + esc(g.Name) + '</span></a>';
      }).join('');
    });
  }

  /* ============ BADGES: "Recently Added" / "New Episodes" on posters ============
     One query per page load: films and shows added in the last 14 days, and shows
     that got a new episode in that time. Cards are matched by their data-id. */
  var BADGE = { asked: false, map: null };
  function loadBadges() {
    var a = api(), u = userId();
    if (BADGE.asked || !a || !u) return;
    BADGE.asked = true;
    var since = Date.now() - 14 * 864e5, map = {};
    var q = { Recursive: true, SortBy: 'DateCreated', SortOrder: 'Descending', Fields: 'DateCreated', EnableImageTypes: '', EnableUserData: false };
    Promise.all([
      a.getItems(u, Object.assign({ IncludeItemTypes: 'Movie,Series', Limit: 80 }, q)),
      a.getItems(u, Object.assign({ IncludeItemTypes: 'Episode', Limit: 150, Fields: 'DateCreated,SeriesId' }, q))
    ]).then(function (r) {
      each((r[0] && r[0].Items) || [], function (i) { if (Date.parse(i.DateCreated) > since) map[i.Id] = 'Recently Added'; });
      each((r[1] && r[1].Items) || [], function (i) { if (i.SeriesId && !map[i.SeriesId] && Date.parse(i.DateCreated) > since) map[i.SeriesId] = 'New Episodes'; });
      BADGE.map = map;
      paintBadges();
    }).catch(function () { BADGE.map = {}; });
  }
  function paintBadges() {
    if (!BADGE.map) { loadBadges(); return; }
    each(document.querySelectorAll('.card[data-id]:not([data-nj-b])'), function (c) {
      c.setAttribute('data-nj-b', '1');
      var label = BADGE.map[c.getAttribute('data-id')], box = label && c.querySelector('.cardScalable');
      if (!box) return;
      var s = document.createElement('span');
      s.className = 'nj-badge';
      s.textContent = label;
      box.appendChild(s);
    });
  }
  window.addEventListener('hashchange', ensureTabBar);

  /* ============ PHONE PLAYER: EPISODES PANEL ============
     An "Episodes" button joins the player's bottom row when an episode is playing.
     It opens a side panel with the season picker and that season's episodes;
     tapping one plays it (through the same details-page Play the hero uses). */
  var EPS = { el: null, item: null, asked: 0, seasons: null };
  var EPS_ICON = '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7.5" width="13" height="10" rx="1.5"/><path d="M7 4.5h12a1.5 1.5 0 0 1 1.5 1.5v9"/></svg>';
  function playingNow() { return !!document.querySelector('.videoPlayerContainer:not(.hide)'); }
  // iOS home-screen apps can place the turned page a status bar lower than asked; measure and pull it back
  function fitRotation() {
    if (!root.classList.contains('nj-playing') || !window.matchMedia('(orientation: portrait)').matches) {
      if (root.style.getPropertyValue('--nj-rot-y')) root.style.removeProperty('--nj-rot-y');
      return;
    }
    var r = document.body.getBoundingClientRect(), cur = parseFloat(root.style.getPropertyValue('--nj-rot-y')) || 0;
    if (Math.abs(r.top) > 0.5) root.style.setProperty('--nj-rot-y', Math.round(cur - r.top) + 'px');
    // 100vh can count the status bar in a home-screen app; size the turned page from the real viewport
    var w = window.innerHeight + 'px', h = window.innerWidth + 'px';
    if (root.style.getPropertyValue('--nj-rot-w') !== w) root.style.setProperty('--nj-rot-w', w);
    if (root.style.getPropertyValue('--nj-rot-h') !== h) root.style.setProperty('--nj-rot-h', h);
  }
  function ensureOsdEpisodes() {
    root.classList.toggle('nj-playing', playingNow());
    // status bar colour in the home-screen app: black while a video plays, the page colour otherwise
    var tc = document.querySelector('meta[name="theme-color"]');
    if (!tc) { tc = document.createElement('meta'); tc.name = 'theme-color'; document.head.appendChild(tc); }
    var want = playingNow() ? '#000000' : getComputedStyle(document.body).backgroundColor;
    if (tc.content !== want) tc.content = want;
    fitRotation();
    var bar = document.querySelector('.videoOsdBottom .buttons');
    if (!bar || !root.classList.contains('layout-mobile') || !playingNow()) { if (!playingNow()) { EPS.item = null; epsClose(); asClose(); } return; }
    if (bar.querySelector('.nj-eps-btn')) return;
    if (EPS.item) { addEpsButton(bar); return; }
    if (Date.now() - EPS.asked < 5000) return;
    EPS.asked = Date.now();
    var a = api();
    if (!a || !a.getSessions) return;
    a.getSessions({ deviceId: a.deviceId() }).then(function (list) {
      var it = list && list[0] && list[0].NowPlayingItem;
      if (!it || it.Type !== 'Episode' || !it.SeriesId) return;
      EPS.item = it;
      var b2 = document.querySelector('.videoOsdBottom .buttons');
      if (b2 && !b2.querySelector('.nj-eps-btn')) addEpsButton(b2);
    }, function () {});
  }
  function addEpsButton(bar) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'paper-icon-button-light nj-eps-btn';
    b.setAttribute('data-nj-do', 'eps');
    b.setAttribute('aria-label', 'Episodes');
    b.innerHTML = EPS_ICON;
    bar.insertBefore(b, bar.querySelector('.btnSubtitles, .btnAudio, .btnVideoOsdSettings'));
  }
  function epsClose() { if (EPS.el) { EPS.el.remove(); EPS.el = null; } }
  function epsOpen() {
    var a = api(), u = userId(), it = EPS.item;
    if (!a || !u || !it) return;
    epsClose();
    var el = document.createElement('aside');
    el.className = 'nj-eps';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Episodes');
    el.innerHTML = '<div class="nj-eps-head"><label class="nj-eps-season"><select aria-label="Season"></select></label>' +
      '<button type="button" class="nj-eps-x" data-nj-do="eps-close" aria-label="Close">&times;</button></div><ol class="nj-eps-list"></ol>';
    document.body.appendChild(el);
    EPS.el = el;
    var sel = el.querySelector('select');
    sel.addEventListener('change', function () { epsLoad(sel.value); });
    a.getJSON(a.getUrl('Shows/' + it.SeriesId + '/Seasons', { userId: u })).then(function (r) {
      var seasons = (r && r.Items) || [];
      sel.innerHTML = seasons.map(function (s) {
        return '<option value="' + esc(s.Id) + '"' + (s.Id === it.SeasonId ? ' selected' : '') + '>' + esc(s.Name) + '</option>';
      }).join('');
      epsLoad(it.SeasonId || (seasons[0] && seasons[0].Id));
    }, function () {});
  }

  /* ============ PHONE PLAYER: DOUBLE-TAP TO SKIP ============
     Double-tap the left part of the picture to go back, the right part to go forward.
     It presses Jellyfin's own skip buttons, so the step is the user's skip length (15 s).
     The second tap's click is cancelled, so the controls don't flash on and off.
     While a portrait phone shows the player turned sideways, the picture's left/right
     runs along the screen's height, so the tap position is read from that axis. */
  var DTAP = { t: 0, side: 0, fb: null, fbTimer: null };
  function playerRotated() { return root.classList.contains('nj-playing') && window.matchMedia('(orientation: portrait)').matches; }
  function dtapFeedback(side) {
    if (!DTAP.fb) {
      DTAP.fb = document.createElement('div');
      DTAP.fb.className = 'nj-dtap';
      DTAP.fb.setAttribute('aria-hidden', 'true');
      document.body.appendChild(DTAP.fb);
    }
    var btn = document.querySelector(side < 0 ? '.videoOsdBottom .btnRewind' : '.videoOsdBottom .btnFastForward');
    var secs = (btn && /(\d+)/.exec(btn.getAttribute('title') || '')) ? '' : '15';
    DTAP.fb.textContent = (side < 0 ? '−' : '+') + (secs || '15') + 's';
    DTAP.fb.setAttribute('data-side', side < 0 ? 'l' : 'r');
    DTAP.fb.classList.remove('nj-dtap--on');
    void DTAP.fb.offsetWidth;
    DTAP.fb.classList.add('nj-dtap--on');
    clearTimeout(DTAP.fbTimer);
    DTAP.fbTimer = setTimeout(function () { if (DTAP.fb) DTAP.fb.classList.remove('nj-dtap--on'); }, 650);
  }
  document.addEventListener('touchend', function (e) {
    if (!root.classList.contains('layout-mobile') || !root.classList.contains('nj-playing')) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t || e.touches.length) return;
    if (e.target.closest && e.target.closest('button, a, input, select, .videoOsdBottom .buttons, .osdPositionSlider, .nj-eps, .actionSheet, .dialog, header, .skinHeader, .videoOsdTop')) return;
    var rel = playerRotated() ? t.clientY / window.innerHeight : t.clientX / window.innerWidth;
    var side = rel < 0.4 ? -1 : rel > 0.6 ? 1 : 0, now = Date.now();
    if (side && now - DTAP.t < 320 && side === DTAP.side) {
      e.preventDefault(); // no click for the second tap
      var btn = document.querySelector(side < 0 ? '.videoOsdBottom .btnRewind' : '.videoOsdBottom .btnFastForward');
      if (btn) { btn.click(); dtapFeedback(side); }
      DTAP.t = now; // a third quick tap skips again
    } else {
      DTAP.t = now; DTAP.side = side;
    }
  }, { capture: true, passive: false });
  // Jellyfin's double-click toggles full screen; on a phone the double tap means skip
  document.addEventListener('dblclick', function (e) {
    if (root.classList.contains('layout-mobile') && root.classList.contains('nj-playing')) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* ============ PHONE PLAYER: AUDIO & SUBTITLES PANEL ============
     The Subtitles button opens one panel with two columns, Audio and Subtitles. Choices
     are read from, and made through, Jellyfin's own audio and subtitle lists (opened
     out of sight), so track switching keeps working exactly as Jellyfin does it. */
  var AS = { el: null, proxy: 0 };
  function waitFor(test, ms) {
    return new Promise(function (ok) {
      var t0 = Date.now();
      (function tick() { var v = test(); if (v || Date.now() - t0 > ms) ok(v); else setTimeout(tick, 40); })();
    });
  }
  function openSheet() { return document.querySelector('.dialogContainer .actionSheet.opened'); }
  function sheetShut(sheet) { return !sheet.isConnected || !sheet.classList.contains('opened'); }
  // Jellyfin's lists sit on the history stack (data-history), so Back closes the list, not the player
  function closeSheet(sheet) {
    if (!sheet || sheetShut(sheet)) return Promise.resolve();
    if (sheet.getAttribute('data-history') === 'true') history.back();
    else sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return waitFor(function () { return sheetShut(sheet); }, 1500);
  }
  // open one of Jellyfin's lists out of sight; act(sheet) reads it or picks an item
  function withSheet(btnSel, act) {
    var btn = document.querySelector('.videoOsdBottom ' + btnSel);
    if (!btn || btn.classList.contains('hide')) return Promise.resolve(null);
    AS.proxy++;
    root.classList.add('nj-sheet-proxy');
    btn.click();
    return waitFor(openSheet, 2000).then(function (sheet) {
      if (!sheet) return null;
      var r = act(sheet);
      return Promise.resolve(r && r.keepOpen ? null : closeSheet(sheet)).then(function () { return r; });
    }).then(function (r) {
      if (--AS.proxy <= 0) { AS.proxy = 0; setTimeout(function () { if (!AS.proxy) root.classList.remove('nj-sheet-proxy'); }, 250); }
      return r;
    });
  }
  function sheetItems(sheet) {
    var out = [];
    each(sheet.querySelectorAll('.actionSheetMenuItem'), function (b) {
      var t = (b.querySelector('.actionSheetItemText') || b).textContent.trim();
      if (!t || /secondary/i.test(t)) return;
      var ic = b.querySelector('.actionsheetMenuItemIcon');
      var on = !!ic && !/hidden/.test(ic.getAttribute('style') || '') && getComputedStyle(ic).visibility !== 'hidden';
      out.push({ t: t, on: on });
    });
    return out;
  }
  function asClose() { if (AS.el) { AS.el.remove(); AS.el = null; } }
  function asColumn(kind, title, items) {
    if (!items || !items.length) return '';
    return '<section class="nj-as-col"><h3>' + title + '</h3><ul>' + items.map(function (i) {
      return '<li><button type="button" class="nj-as-opt" data-nj-do="as-pick" data-nj-id="' + kind + '" data-t="' + esc(i.t) + '"' + (i.on ? ' aria-current="true"' : '') + '>' +
        '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg><span>' + esc(i.t) + '</span></button></li>';
    }).join('') + '</ul></section>';
  }
  function asOpen() {
    asClose();
    var el = document.createElement('div');
    el.className = 'nj-as';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Audio and subtitles');
    el.innerHTML = '<button type="button" class="nj-as-x" data-nj-do="as-close" aria-label="Close">' +
      '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button><div class="nj-as-cols"></div>';
    document.body.appendChild(el);
    AS.el = el;
    var audio;
    withSheet('.btnAudio', sheetItems).then(function (a) {
      audio = a;
      return withSheet('.btnSubtitles', sheetItems);
    }).then(function (subs) {
      if (!AS.el) return;
      AS.el.querySelector('.nj-as-cols').innerHTML = asColumn('audio', 'Audio', audio) + asColumn('subs', 'Subtitles', subs);
    });
  }
  function asPick(btn) {
    var kind = btn.getAttribute('data-nj-id'), t = btn.getAttribute('data-t');
    each(btn.closest('ul').querySelectorAll('.nj-as-opt'), function (o) { o.removeAttribute('aria-current'); });
    btn.setAttribute('aria-current', 'true');
    withSheet(kind === 'audio' ? '.btnAudio' : '.btnSubtitles', function (sheet) {
      var hit = null;
      each(sheet.querySelectorAll('.actionSheetMenuItem'), function (b) {
        if (!hit && (b.querySelector('.actionSheetItemText') || b).textContent.trim() === t) hit = b;
      });
      if (hit) { hit.click(); return { keepOpen: true }; } // picking closes Jellyfin's list itself
      return null;
    });
  }
  // the Subtitles button opens the combined panel (unless the panel itself is driving it)
  document.addEventListener('click', function (e) {
    if (AS.proxy || !root.classList.contains('layout-mobile') || !root.classList.contains('nj-playing')) return;
    var b = e.target.closest && e.target.closest('.videoOsdBottom .btnSubtitles');
    if (!b) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    asOpen();
  }, true);

  /* ============ PHONE HOME: CONTINUE WATCHING AS POSTERS ============
     Resume cards (the ones with a progress bar) get the film or show poster instead of a
     wide still, and an info / more row under the progress bar. One lookup per new batch. */
  var CW = { pending: false, sheet: null };
  function paintContinue() {
    if (!root.classList.contains('layout-mobile') || CW.pending) return;
    var cards = [];
    each(document.querySelectorAll('.homeSectionsContainer .card[data-id]:not([data-nj-cw])'), function (c) {
      if (c.querySelector('.itemProgressBar')) cards.push(c);
      else c.setAttribute('data-nj-cw', '0');
    });
    if (!cards.length) return;
    var a = api(), u = userId();
    if (!a || !u) return;
    CW.pending = true;
    var ids = cards.map(function (c) { return c.getAttribute('data-id'); });
    a.getItems(u, { Ids: ids.join(','), Fields: 'SeriesPrimaryImageTag', EnableImageTypes: 'Primary', ImageTypeLimit: 1 }).then(function (r) {
      var art = {};
      each((r && r.Items) || [], function (i) {
        if (i.SeriesId && i.SeriesPrimaryImageTag) art[i.Id] = imageUrl(i.SeriesId, 'Primary', i.SeriesPrimaryImageTag, 360);
        else if (i.ImageTags && i.ImageTags.Primary && i.Type !== 'Episode') art[i.Id] = imageUrl(i.Id, 'Primary', i.ImageTags.Primary, 360);
      });
      each(cards, function (c) {
        var id = c.getAttribute('data-id'), url = art[id];
        c.setAttribute('data-nj-cw', url ? '1' : '0');
        if (!url) return;
        c.style.setProperty('--nj-poster', 'url("' + url + '")');
        var box = c.querySelector('.cardBox') || c;
        if (!box.querySelector('.nj-cw-foot')) {
          var f = document.createElement('div');
          f.className = 'nj-cw-foot';
          f.innerHTML = '<a class="nj-cw-b" href="' + esc(detailsHash(id)) + '" aria-label="Details">' + ICON.info + '</a>' +
            '<button type="button" class="nj-cw-b" data-nj-do="cw-menu" aria-label="More">' +
            '<svg class="nj-ico nj-ico--fill" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="18.5" r="1.8"/></svg></button>';
          box.appendChild(f);
        }
      });
    }, function () { each(cards, function (c) { c.removeAttribute('data-nj-cw'); }); })
      .then(function () { CW.pending = false; });
  }
  // "more": a small sheet with Details and Mark as watched
  function cwMenu(btn) {
    var card = btn.closest('.card'), id = card && card.getAttribute('data-id');
    if (!id) return;
    cwClose();
    var el = document.createElement('div');
    el.className = 'nj-sheet';
    el.innerHTML = '<div class="nj-sheet-bd" data-nj-do="cw-close"></div><div class="nj-sheet-in" role="dialog" aria-label="More">' +
      '<a class="nj-sheet-i" href="' + esc(detailsHash(id)) + '" data-nj-do="cw-close">' + ICON.info + '<span>Episodes &amp; Info</span></a>' +
      '<button type="button" class="nj-sheet-i" data-nj-do="cw-played" data-nj-id="' + esc(id) + '"><svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg><span>Mark as watched</span></button>' +
      '<button type="button" class="nj-sheet-i nj-sheet-cancel" data-nj-do="cw-close"><span>Cancel</span></button></div>';
    document.body.appendChild(el);
    CW.sheet = el;
  }
  function cwClose() { if (CW.sheet) { CW.sheet.remove(); CW.sheet = null; } }
  function cwPlayed(id) {
    var a = api(), u = userId();
    cwClose();
    if (!a || !u || !id) return;
    Promise.resolve(a.markPlayed(u, id, new Date())).then(function () {
      each(document.querySelectorAll('.card[data-nj-cw="1"][data-id="' + id + '"]'), function (c) { c.remove(); });
    }, function () {});
  }
  function epsLoad(seasonId) {
    var a = api(), u = userId(), it = EPS.item, list = EPS.el && EPS.el.querySelector('.nj-eps-list');
    if (!list || !seasonId) return;
    a.getJSON(a.getUrl('Shows/' + it.SeriesId + '/Episodes', { seasonId: seasonId, userId: u, Fields: 'Overview', EnableUserData: true, EnableImageTypes: 'Primary', ImageTypeLimit: 1 })).then(function (r) {
      list.innerHTML = ((r && r.Items) || []).map(function (e) {
        var tag = e.ImageTags && e.ImageTags.Primary, cur = e.Id === it.Id, mins = e.RunTimeTicks ? Math.round(e.RunTimeTicks / 6e8) + 'm' : '';
        var pct = e.UserData && (e.UserData.Played ? 100 : e.UserData.PlayedPercentage || 0);
        return '<li><button type="button" class="nj-ep' + (cur ? ' nj-ep--cur' : '') + '" data-nj-do="ep" data-nj-id="' + esc(e.Id) + '"' + (cur ? ' aria-current="true"' : '') + '>' +
          '<span class="nj-ep-img">' + (tag ? '<img alt="" loading="lazy" src="' + esc(imageUrl(e.Id, 'Primary', tag, 400)) + '">' : '') +
          (pct ? '<i class="nj-ep-bar" style="--p:' + (pct / 100).toFixed(3) + '"></i>' : '') + '</span>' +
          '<span class="nj-ep-t">' + (e.IndexNumber != null ? e.IndexNumber + '. ' : '') + esc(e.Name) + '</span>' +
          '<span class="nj-ep-m">' + mins + '</span>' +
          (e.Overview ? '<span class="nj-ep-o">' + esc(e.Overview) + '</span>' : '') + '</button></li>';
      }).join('');
      var c = list.querySelector('.nj-ep--cur');
      if (c) c.scrollIntoView({ block: 'center' });
    }, function () {});
  }

  function ensureThemeButton() {
    if (!NJ.themeControl) return;
    // MUI app bar: just left of the avatar box (CSS order keeps it there if React reorders)
    var bar = document.querySelector('header.MuiAppBar-root .MuiToolbar-root');
    if (bar && !bar.querySelector(':scope > .nj-theme-btn')) { bar.insertBefore(themeButton(), bar.lastElementChild); applyTheme(); }
    // a Home button in the top bar on every page (phones also have it in the tab bar)
    if (bar && !bar.querySelector('.nj-homebtn')) {
      var hb = document.createElement('a');
      hb.className = 'nj-homebtn nj-theme-btn';
      hb.href = '#/home';
      hb.setAttribute('aria-label', 'Home');
      hb.innerHTML = '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.8 12 3.5l8.5 7.3V20a.5.5 0 0 1-.5.5h-4.5v-6h-7v6H4a.5.5 0 0 1-.5-.5z"/></svg>';
      var tb = bar.querySelector(':scope > .nj-theme-btn');
      bar.insertBefore(hb, tb || bar.lastElementChild);
    }
    var right = document.querySelector('.skinHeader .headerRight');
    if (right && !right.querySelector('.nj-theme-btn')) {
      right.insertBefore(themeButton(), right.querySelector('.headerUserButton'));
      applyTheme();
    }
  }

  /* ============ HERO ============ */
  var HERO = { el: null, items: null, queue: null, cur: 0, timer: null, loading: false, failedAt: 0, none: false };

  function findHomeSections() {
    var list = document.querySelectorAll('.homeSectionsContainer, #homeTab .sections');
    for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
    return null;
  }
  /* Billboard picks: about six random movies/series that have a backdrop, a new set on every
     visit to Home. Titles with a clip in the trailers folder go first. Which ids have clips comes
     from an optional index.json there (array of item ids) plus HEAD checks, kept for the session. */
  var CLIPS = null;
  function clipIndex() {
    if (!CLIPS) {
      CLIPS = !TRAILERS ? Promise.resolve({}) : fetch(TRAILERS + 'index.json', { credentials: 'same-origin', cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (d) {
          var known = {};
          (Array.isArray(d) ? d : (d && d.items) || []).forEach(function (x) {
            var id = typeof x === 'string' ? x : x && x.id;
            if (id) { known[id] = true; PV.heads[id] = Promise.resolve(true); }
          });
          return known;
        }, function () { return {}; });
    }
    return CLIPS;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function loadHeroItems() {
    var a = api(), u = userId();
    if (!a || !u) return Promise.reject(new Error('no ApiClient yet'));
    var q = { IncludeItemTypes: 'Movie,Series', Recursive: true, ImageTypes: 'Backdrop', Fields: 'Overview,Genres,ChildCount',
      EnableImageTypes: 'Backdrop,Logo,Primary', ImageTypeLimit: 1, EnableUserData: true };
    var index = {};
    return clipIndex().then(function (known) {
      index = known;
      var ids = shuffle(Object.keys(known)).slice(0, NJ.hero.count);
      return Promise.all([
        ids.length ? a.getItems(u, Object.assign({ Ids: ids.join(',') }, q)).then(function (r) { return (r && r.Items) || []; }, function () { return []; }) : [],
        a.getItems(u, Object.assign({ SortBy: 'Random', Limit: 30 }, q)).then(function (r) { return (r && r.Items) || []; })
      ]);
    }).then(function (res) {
      var seen = {}, pool = [];
      res[0].concat(res[1]).forEach(function (it) {
        if (!seen[it.Id] && it.BackdropImageTags && it.BackdropImageTags.length) { seen[it.Id] = 1; pool.push(it); }
      });
      // with an index.json it is the whole truth (no requests); without one, HEAD-check each pick
      var haveIndex = Object.keys(index).length > 0;
      return Promise.all(pool.map(function (it) {
        return (haveIndex ? Promise.resolve(!!index[it.Id]) : hasTrailer(it.Id)).then(function (ok) { return { it: it, clip: ok }; });
      }));
    }).then(function (rows) {
      var clip = shuffle(rows.filter(function (r) { return r.clip; }).map(function (r) { return r.it; }));
      var rest = rows.filter(function (r) { return !r.clip; }).map(function (r) { return r.it; }); // already random
      return clip.concat(rest).slice(0, NJ.hero.count);
    });
  }
  // draw the next visit's set in the background and warm its first backdrop
  function prefetchHero() {
    loadHeroItems().then(function (items) {
      if (!items.length) return;
      HERO.queue = items;
      new Image().src = imageUrl(items[0].Id, 'Backdrop', items[0].BackdropImageTags[0], 1920);
    }, function () { /* keep the current set */ });
  }
  // "+ My List" (phones): Jellyfin favourites are the list
  function favBtnHtml(it) {
    var on = !!(it.UserData && it.UserData.IsFavorite);
    return '<button type="button" class="nj-btn nj-btn--ghost nj-btn--list" data-nj-do="fav" data-nj-id="' + esc(it.Id) + '" aria-pressed="' + on + '">' +
      '<svg class="nj-ico nj-i-add" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' +
      '<svg class="nj-ico nj-i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>My List</button>';
  }
  function toggleFav(btn) {
    var a = api(), u = userId(), id = btn.getAttribute('data-nj-id'), want = btn.getAttribute('aria-pressed') !== 'true';
    if (!a || !u || !id || btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute('aria-pressed', String(want));
    var p = a.updateFavoriteStatus ? a.updateFavoriteStatus(u, id, want)
      : fetch(a.getUrl('UserFavoriteItems/' + id, { userId: u }), { method: want ? 'POST' : 'DELETE', headers: { Authorization: 'MediaBrowser Token="' + a.accessToken() + '"' } })
        .then(function (r) { if (!r.ok) throw new Error(r.status); });
    Promise.resolve(p).catch(function () { btn.setAttribute('aria-pressed', String(!want)); })
      .then(function () { btn.disabled = false; });
  }
  function slideHtml(it, i) {
    var logo = it.ImageTags && it.ImageTags.Logo;
    var poster = it.ImageTags && it.ImageTags.Primary;
    var pr = progress(it);
    return '<div class="nj-hero-slide' + (i === 0 ? ' nj-on' : '') + '" data-i="' + i + '"' + (i ? ' aria-hidden="true" inert' : '') + '>' +
      '<div class="nj-hero-media"><img class="nj-hero-backdrop" src="' + esc(imageUrl(it.Id, 'Backdrop', it.BackdropImageTags[0], 1920)) + '" alt=""' + (i ? ' loading="lazy"' : '') + '></div>' +
      '<div class="nj-hero-content">' +
        (poster ? '<a class="nj-hero-poster" href="' + esc(detailsHash(it.Id)) + '" aria-label="' + esc(it.Name) + '"><img src="' + esc(imageUrl(it.Id, 'Primary', poster, 480)) + '" alt=""' + (i ? ' loading="lazy"' : '') + '></a>' : '') +
        '<h2 class="nj-hero-logo">' + (logo ? '<img src="' + esc(imageUrl(it.Id, 'Logo', logo, 800)) + '" alt="' + esc(it.Name) + '">' : esc(it.Name)) + '</h2>' +
        metaHtml(it) +
        (it.Overview ? '<p class="nj-hero-overview">' + esc(it.Overview) + '</p>' : '') +
        '<div class="nj-hero-actions">' +
          '<button type="button" class="nj-btn nj-btn--primary" data-nj-do="play" data-nj-id="' + esc(it.Id) + '">' + ICON.play + (pr ? 'Resume' : 'Play') + '</button>' +
          '<a class="nj-btn nj-btn--ghost" href="' + esc(detailsHash(it.Id)) + '">' + ICON.info + 'More Info</a>' +
          favBtnHtml(it) +
          (pr ? '<span class="nj-hero-resume"><span class="nj-bar"><i style="--p:' + pr.p.toFixed(3) + '"></i></span>' + pr.left + ' left</span>' : '') +
        '</div>' +
      '</div></div>';
  }
  function fillHero(el, items) {
    // the sound toggle sits in the dots row, level with Play / More Info, so Right on the remote reaches it
    el.innerHTML = items.map(slideHtml).join('') +
      '<div class="nj-hero-dots">' +
        '<button type="button" class="nj-hero-sound" data-nj-do="sound" aria-pressed="false">' + ICON.mute + ICON.vol + '<span>Muted</span></button>' +
        (items.length > 1 ? items.map(function (it, i) {
          return '<button type="button" class="nj-hero-dot' + (i === 0 ? ' nj-on' : '') + '" data-nj-do="go" data-nj-id="' + i + '" aria-label="Show ' + esc(it.Name) + '" aria-current="' + (i === 0) + '"></button>';
        }).join('') : '') +
      '</div>';
    el.classList.remove('nj-empty');
    each(el.querySelectorAll('.nj-hero-logo img'), markWhiteLogo);
    HERO.cur = 0;
    restartCarousel();
    pvArm();
  }
  // Most title logos are white artwork. Measure each (same-origin image, so the canvas is
  // readable) and tag the white ones, so the light theme can print them in ink instead.
  function markWhiteLogo(img) {
    function check() {
      try {
        var c = document.createElement('canvas'); c.width = 48; c.height = 24;
        var x = c.getContext('2d'); x.drawImage(img, 0, 0, 48, 24);
        var d = x.getImageData(0, 0, 48, 24).data, sum = 0, n = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++;
        }
        if (n && sum / n > 0.72) img.classList.add('nj-logo-white');
      } catch (e) { /* unreadable: leave as is */ }
    }
    if (img.complete && img.naturalWidth) check(); else img.addEventListener('load', check, { once: true });
  }
  /* Mount the hero synchronously as a fixed-size shell in the same frame the home
     sections appear, then fill it. Its size never changes, so the rows below never move. */
  function mountHero(sections) {
    if (HERO.none) return;
    var el = document.createElement('section');
    el.className = 'nj-hero nj-empty';
    el.setAttribute('aria-roledescription', 'carousel');
    el.setAttribute('aria-label', 'Featured');
    el.style.setProperty('--nj-interval', NJ.hero.intervalMs / 1000 + 's');
    sections.parentNode.classList.add('nj-hero-host'); // a block formatting context, so the hero's pull-up margin can't collapse into it
    sections.parentNode.insertBefore(el, sections);
    HERO.el = el;
    el.addEventListener('pointerenter', function () { el.classList.add('nj-paused'); });
    el.addEventListener('pointerleave', function () { el.classList.remove('nj-paused'); });
    el.addEventListener('focusin', function () { el.classList.add('nj-paused'); });
    el.addEventListener('focusout', function () { el.classList.remove('nj-paused'); });
    fitHero();
    // a fresh set every visit: use the one drawn in the background last time, then draw the next
    if (HERO.queue) { HERO.items = HERO.queue; HERO.queue = null; fillHero(el, HERO.items); prefetchHero(); return; }
    if (HERO.loading || Date.now() - HERO.failedAt < 30000) { if (HERO.items) fillHero(el, HERO.items); return; }
    HERO.loading = true;
    loadHeroItems().then(function (items) {
      HERO.loading = false;
      if (!items.length) { HERO.none = true; if (HERO.el) HERO.el.remove(); HERO.el = null; return; }
      HERO.items = items;
      if (HERO.el && HERO.el.isConnected) fillHero(HERO.el, items);
      prefetchHero();
    }, function () { HERO.loading = false; HERO.failedAt = Date.now(); if (HERO.items && HERO.el) fillHero(HERO.el, HERO.items); });
  }
  // pull the hero up under the fixed header and out to the window edges
  // Measured on the host (not the hero), so it is stable: only writes when the page offset changes.
  function fitHero() {
    var el = HERO.el;
    if (!visible(el)) return;
    var host = el.parentNode.getBoundingClientRect();
    var pull = Math.round(-(host.top + (window.scrollY || 0))) + 'px';
    var left = Math.round(-host.left) + 'px';
    var width = root.clientWidth + 'px';
    var head = headerEl();
    var headH = Math.round(head ? head.getBoundingClientRect().height : 56) + 'px';
    if (el.style.getPropertyValue('--nj-pull') !== pull) el.style.setProperty('--nj-pull', pull);
    if (el.style.marginLeft !== left) el.style.marginLeft = left;
    if (el.style.width !== width) el.style.width = width;
    if (el.style.getPropertyValue('--nj-head') !== headH) el.style.setProperty('--nj-head', headH);
  }
  function showSlide(i) {
    var el = HERO.el; if (!el || !HERO.items) return;
    pvStop();
    HERO.cur = (i + HERO.items.length) % HERO.items.length;
    each(el.querySelectorAll('.nj-hero-slide'), function (s, j) {
      var on = j === HERO.cur;
      s.classList.toggle('nj-on', on);
      if (on) { s.removeAttribute('aria-hidden'); s.removeAttribute('inert'); }
      else { s.setAttribute('aria-hidden', 'true'); s.setAttribute('inert', ''); }
    });
    each(el.querySelectorAll('.nj-hero-dot'), function (d, j) {
      d.classList.toggle('nj-on', j === HERO.cur);
      d.setAttribute('aria-current', String(j === HERO.cur));
    });
    restartCarousel();
    pvArm();
  }
  function stopCarousel() { clearTimeout(HERO.timer); HERO.timer = null; if (HERO.el) HERO.el.classList.remove('nj-auto'); }
  function restartCarousel() {
    var el = HERO.el;
    stopCarousel();
    if (!el || !HERO.items || reduced.matches || HERO.items.length < 2 || !visible(el)) return;
    void el.offsetWidth; // restart the dot fill animation
    el.classList.add('nj-auto');
    HERO.timer = setTimeout(function () {
      if (el.classList.contains('nj-paused') || el.classList.contains('nj-previewing')) restartCarousel();
      else showSlide(HERO.cur + 1);
    }, NJ.hero.intervalMs);
  }

  /* ============ IDLE TRAILER ============
     The clip is sized by CSS from its first frame (absolute, object-fit: cover)
     and stays at opacity 0 until 'playing', then crossfades over the still. */
  var PV = { timer: null, slide: null, video: null, awakeT: null, heads: {} };
  function soundWanted() { return store.get('nj-sound') === 'on'; } // default: muted

  function hasTrailer(id) {
    if (!TRAILERS) return Promise.resolve(false);
    if (!PV.heads[id]) {
      PV.heads[id] = fetch(TRAILERS + encodeURIComponent(id) + '.mp4', { method: 'HEAD', credentials: 'same-origin' })
        .then(function (r) { return r.ok; }, function () { return false; });
    }
    return PV.heads[id];
  }
  function heroInView() {
    var el = HERO.el;
    if (!visible(el) || document.hidden) return false;
    var r = el.getBoundingClientRect();
    var shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return r.height > 0 && shown / Math.min(r.height, window.innerHeight) >= 0.35;
  }
  function pvEligible() { return !!HERO.items && !WHO.el && !reduced.matches && window.innerWidth > 720 && !root.classList.contains('layout-mobile') && heroInView(); }
  function pvArm() {
    clearTimeout(PV.timer);
    if (PV.slide || !pvEligible()) return;
    var at = HERO.cur;
    PV.timer = setTimeout(function () { pvStart(at); }, IDLE_MS);
  }
  function syncSoundButton() {
    var b = HERO.el && HERO.el.querySelector('.nj-hero-sound');
    if (!b) return;
    var on = PV.video ? !PV.video.muted : soundWanted();
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Mute trailer' : 'Turn trailer sound on');
    b.querySelector('span').textContent = on ? 'Sound on' : 'Muted';
  }
  function pvStart(at) {
    var it = HERO.items && HERO.items[at];
    if (!it || at !== HERO.cur || PV.slide) return;
    hasTrailer(it.Id).then(function (ok) {
      if (!ok || at !== HERO.cur || PV.slide || !pvEligible()) return;
      var slide = HERO.el.querySelectorAll('.nj-hero-slide')[at];
      var media = slide.querySelector('.nj-hero-media');
      var v = media.querySelector('.nj-hero-video');
      if (!v) {
        v = document.createElement('video');
        v.className = 'nj-hero-video';
        v.playsInline = true; v.preload = 'auto';
        v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true'); v.tabIndex = -1;
        v.src = TRAILERS + encodeURIComponent(it.Id) + '.mp4';
        v.addEventListener('ended', function () { if (PV.video === v) { pvStop(); showSlide(HERO.cur + 1); } });
        // the still hides only while frames are really on screen
        v.addEventListener('playing', function () { if (PV.video === v) slide.classList.add('nj-playing'); });
        v.addEventListener('pause', function () { slide.classList.remove('nj-playing'); });
        v.addEventListener('waiting', function () { slide.classList.remove('nj-playing'); });
        v.addEventListener('error', function () { if (PV.video === v) pvStop(); });
        v.addEventListener('volumechange', syncSoundButton);
        // phones: the clip plays inside the poster card, muted
        var card = root.classList.contains('layout-mobile') && slide.querySelector('.nj-hero-poster');
        if (card) card.appendChild(v); else media.insertBefore(v, media.firstChild.nextSibling);
      }
      v.muted = root.classList.contains('layout-mobile') || !soundWanted();
      try { v.currentTime = 0; } catch (e) { /* not loaded yet */ }
      PV.slide = slide; PV.video = v;
      HERO.el.classList.add('nj-previewing');
      syncSoundButton();
      v.play().catch(function () {
        if (PV.video !== v) return;
        if (!v.muted) { v.muted = true; v.play().catch(function () { if (PV.video === v) pvStop(); }); } // browser blocked sound
        else pvStop();
      });
    });
  }
  function pvStop() {
    clearTimeout(PV.timer); clearTimeout(PV.awakeT);
    var s = PV.slide, v = PV.video;
    PV.slide = null; PV.video = null;
    if (HERO.el) HERO.el.classList.remove('nj-previewing');
    if (s) s.classList.remove('nj-playing', 'nj-awake');
    if (v) setTimeout(function () { if (PV.video !== v) v.pause(); }, 750); // after the fade
    syncSoundButton();
  }
  function onActivity(e) {
    if (!HERO.el) return;
    if (PV.slide) {
      if (e.type === 'scroll' || e.type === 'wheel') { if (!pvEligible()) pvStop(); return; }
      PV.slide.classList.add('nj-awake');
      clearTimeout(PV.awakeT);
      PV.awakeT = setTimeout(function () { if (PV.slide) PV.slide.classList.remove('nj-awake'); }, 2500);
      return;
    }
    pvArm();
  }
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (t) {
    window.addEventListener(t, onActivity, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (PV.video) PV.video.pause(); clearTimeout(PV.timer); }
    else if (PV.video) PV.video.play().catch(function () { pvStop(); });
    else pvArm();
  });

  /* ============ TOP 10 ROW ============
     top10.url (a JSON file) lists owned titles in rank order; without one the row is
     built from the user's own play counts. Data is fetched once at boot so
     the row can be inserted in the same frame its neighbour rows render. A missing
     or empty file renders nothing. */
  var TOP = { state: 'idle', items: [] };
  function loadTop10() {
    if (!NJ.top10.enabled || TOP.state !== 'idle' || !api() || !userId()) return;
    TOP.state = 'loading';
    (NJ.top10.url ? fetch(NJ.top10.url, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }) : top10FromServer())
      .then(function (d) {
        var list = d && Array.isArray(d.items) ? d.items.filter(function (x) { return x && x.id; }) : [];
        list.sort(function (a, b) { return (a.rank || 99) - (b.rank || 99); });
        list = list.slice(0, 10);
        if (!list.length) { TOP.state = 'none'; return null; }
        return api().getItems(userId(), { Ids: list.map(function (x) { return x.id; }).join(','), EnableImageTypes: 'Primary', ImageTypeLimit: 1 })
          .then(function (res) {
            var byId = {};
            ((res && res.Items) || []).forEach(function (it) { byId[it.Id] = it; });
            TOP.items = list.map(function (x) { return byId[x.id]; }).filter(function (it) { return it && it.ImageTags && it.ImageTags.Primary; });
            TOP.state = TOP.items.length ? 'ready' : 'none';
            schedule();
          });
      })
      .catch(function () { TOP.state = 'none'; });
  }
  // no top10.url: the signed-in user's most played movies and shows, most recent first on a tie
  function top10FromServer() {
    var a = api(), u = userId(), img = { EnableImageTypes: 'Primary', ImageTypeLimit: 1, Recursive: true, SortOrder: 'Descending', Limit: 10 };
    return a.getItems(u, Object.assign({ IncludeItemTypes: 'Movie,Series', SortBy: 'PlayCount,DatePlayed', Filters: 'IsPlayed' }, img))
      .then(function (r) {
        var items = (r && r.Items) || [];
        if (items.length >= 10) return items;
        // a show counts as played only when every episode is: add shows with some progress
        return a.getItems(u, Object.assign({ IncludeItemTypes: 'Series', SortBy: 'DatePlayed', Filters: 'IsResumable' }, img)).then(function (r2) {
          var seen = {};
          items.forEach(function (it) { seen[it.Id] = 1; });
          ((r2 && r2.Items) || []).forEach(function (it) { if (!seen[it.Id] && items.length < 10) { seen[it.Id] = 1; items.push(it); } });
          return items;
        }, function () { return items; });
      })
      .then(function (items) {
        // fewer than 3 titles is not a ranking: no row
        return items.length >= 3 ? { items: items.map(function (it, i) { return { id: it.Id, rank: i + 1 }; }) } : null;
      });
  }
  function top10Title() { return NJ.top10.title || (NJ.top10.url ? 'Top 10 this week' : 'Top 10'); }
  function sectionTitle(s) { var t = s.querySelector('.sectionTitle'); return t ? t.textContent.trim() : ''; }
  function top10Html() {
    return '<div class="nj-row-head"><h2 class="sectionTitle sectionTitle-cards">' + esc(top10Title()) + '</h2>' +
        '<div class="nj-row-nav"><button type="button" data-nj-do="t10" data-nj-id="-1" aria-label="Scroll Top 10 back">' + ICON.left + '</button>' +
        '<button type="button" data-nj-do="t10" data-nj-id="1" aria-label="Scroll Top 10 forward">' + ICON.right + '</button></div></div>' +
      '<div class="nj-t10-track" role="list">' + TOP.items.map(function (it, i) {
        return '<a class="nj-t10" role="listitem" data-rank="' + (i + 1) + '" href="' + esc(detailsHash(it.Id)) + '">' +
          '<span class="nj-t10-num" aria-hidden="true">' + (i + 1) + '</span>' +
          '<span class="nj-t10-media"><img src="' + esc(imageUrl(it.Id, 'Primary', it.ImageTags.Primary, 400)) + '" alt="" loading="lazy"></span>' +
          '<span class="nj-sr">' + (i + 1) + '. ' + esc(it.Name) + '</span></a>';
      }).join('') + '</div>';
  }
  function syncTop10(sections) {
    if (TOP.state === 'idle') loadTop10();
    if (TOP.state !== 'ready' || !sections || sections.querySelector('.nj-top10')) return;
    // section slots: the "latest media" slot is a plain div that holds several Recently Added rows
    var rows = Array.prototype.filter.call(sections.children, function (s) { return !s.classList.contains('hide') && !s.classList.contains('nj-top10'); });
    // right after Continue Watching / Next Up, before the first Recently Added row
    var anchor = rows.filter(function (s) { return /^(Recently Added|Latest)/i.test(sectionTitle(s)); })[0];
    if (!anchor) return;
    var row = document.createElement('div');
    row.className = 'verticalSection nj-top10';
    row.innerHTML = top10Html();
    sections.insertBefore(row, anchor);
    syncTop10Nav(row);
    row.querySelector('.nj-t10-track').addEventListener('scroll', function () { syncTop10Nav(row); }, { passive: true });
  }
  function syncTop10Nav(row) {
    var tr = row.querySelector('.nj-t10-track'), b = row.querySelectorAll('.nj-row-nav button');
    if (!tr || b.length < 2) return;
    b[0].disabled = tr.scrollLeft < 4;
    b[1].disabled = tr.scrollLeft + tr.clientWidth >= tr.scrollWidth - 4;
  }


  /* ============ HOME: COLLECTIONS, CURATED ROWS, "<ACTOR> DAY" ============
     Built after Top 10 from one library query (films and shows with their people and
     studios) plus the library's collections. Rows change by day, never within a day. */
  var XR = { state: 'idle', rows: null };
  function dayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function daySeed(s) { var h = 0, k = dayKey() + s; for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; return Math.abs(h); }
  function shuffled(list, salt) {
    return list.map(function (x, i) { return { x: x, k: daySeed(salt + i) }; }).sort(function (a, b) { return a.k - b.k; }).map(function (o) { return o.x; });
  }
  function loadXRows() {
    var a = api(), u = userId();
    if (!a || !u) return;
    XR.state = 'loading';
    var q = { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: 'People,Studios', EnableImageTypes: 'Primary', ImageTypeLimit: 1, Limit: 2000 };
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('nj-births') || 'null'); } catch (e) { /* none */ }
    var births = cached && cached.day === dayKey() ? Promise.resolve(cached.b)
      : a.getJSON(a.getUrl('Persons', { userId: u, Fields: 'PremiereDate', Limit: 5000 })).then(function (r) {
        var b = {};
        each((r && r.Items) || [], function (p) { if (p.PremiereDate) b[p.Name] = p.PremiereDate.slice(5, 10); });
        try { localStorage.setItem('nj-births', JSON.stringify({ day: dayKey(), b: b })); } catch (e) { /* private mode */ }
        return b;
      }, function () { return {}; });
    Promise.all([
      a.getItems(u, q),
      a.getItems(u, { Recursive: true, IncludeItemTypes: 'BoxSet', EnableImageTypes: 'Primary', ImageTypeLimit: 1, Limit: 60 }),
      births
    ]).then(function (r) {
      var items = ((r[0] && r[0].Items) || []).filter(function (i) { return i.ImageTags && i.ImageTags.Primary; });
      var sets = ((r[1] && r[1].Items) || []).filter(function (i) { return i.ImageTags && i.ImageTags.Primary; });
      var born = r[2] || {}, rows = [];
      if (sets.length) rows.push({ title: 'Collections', items: shuffled(sets, 'sets') });
      // "<Actor> Day": born today (or the nearest birthday this week), with at least two titles here
      var byActor = {}, byDirector = {}, byStudio = {};
      each(items, function (it) {
        each(it.People || [], function (p) {
          if (p.Type === 'Actor') (byActor[p.Name] = byActor[p.Name] || []).push(it);
          if (p.Type === 'Director') (byDirector[p.Name] = byDirector[p.Name] || []).push(it);
        });
        each(it.Studios || [], function (s) { (byStudio[s.Name] = byStudio[s.Name] || []).push(it); });
      });
      var now = new Date(), best = null;
      for (var off = 0; off < 7 && !best; off++) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
        var md = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
        Object.keys(byActor).forEach(function (n) {
          if (born[n] === md && byActor[n].length >= 2 && (!best || byActor[n].length > byActor[best.n].length)) best = { n: n, off: off };
        });
      }
      if (best) rows.push({ title: best.n + (best.off ? ' Week' : ' Day'), items: byActor[best.n] });
      // curated: a director and a studio with enough titles, picked by day
      var dirs = shuffled(Object.keys(byDirector).filter(function (n) { return byDirector[n].length >= 3; }), 'dir');
      if (dirs[0]) rows.push({ title: 'Directed by ' + dirs[0], items: byDirector[dirs[0]] });
      var studios = shuffled(Object.keys(byStudio).filter(function (n) { return byStudio[n].length >= 4 && byStudio[n].length <= 30; }), 'studio');
      if (studios[0]) rows.push({ title: 'From ' + studios[0], items: byStudio[studios[0]] });
      XR.rows = rows;
      XR.state = 'ready';
    }, function () { XR.state = 'none'; });
  }
  function xrowHtml(row) {
    return '<div class="sectionTitleContainer"><h2 class="sectionTitle">' + esc(row.title) + '</h2></div>' +
      '<div class="nj-xr-track" role="list">' + row.items.slice(0, 24).map(function (it) {
        return '<a class="nj-xr" role="listitem" href="' + esc(detailsHash(it.Id)) + '" aria-label="' + esc(it.Name) + '">' +
          '<img src="' + esc(imageUrl(it.Id, 'Primary', it.ImageTags.Primary, 320)) + '" alt="" loading="lazy"></a>';
      }).join('') + '</div>';
  }
  function syncXRows(sections) {
    if (XR.state === 'idle') loadXRows();
    if (XR.state !== 'ready' || !sections || sections.querySelector('.nj-xrow')) return;
    var top = sections.querySelector('.nj-top10');
    if (!top) return;
    var after = top;
    each(XR.rows, function (row) {
      var el = document.createElement('div');
      el.className = 'verticalSection nj-xrow';
      el.innerHTML = xrowHtml(row);
      sections.insertBefore(el, after.nextSibling);
      after = el;
    });
  }
  /* ============ DETAIL PAGE ============ */
  function detailId() { var m = /[?&]id=([0-9a-f]{32})/i.exec(location.hash); return m ? m[1] : null; }

  /* ============ PHONE TITLE PAGE: TABS (Episodes / Collection / More Like This) ============
     A tab bar at the top of the lower half of the page. Episodes is our own list (season picker,
     thumbnail, runtime, synopsis); More Like This and Collection are Jellyfin's own sections,
     shown or hidden by the tab. Jellyfin's Next Up and Seasons blocks give way to the list. */
  var TD = { id: null };
  function syncTitleTabs(page) {
    if (!page || !root.classList.contains('layout-mobile')) return;
    var sec = page.querySelector('.detailPageSecondaryContainer'), id = detailId();
    if (!sec || !id) return;
    var bar = sec.querySelector(':scope > .nj-td');
    if (bar && bar.getAttribute('data-id') === id) { tdRefresh(page, bar); return; }
    if (bar) bar.remove();
    each(sec.querySelectorAll(':scope > .nj-td-eps'), function (x) { x.remove(); });
    getItem(id).then(function (it) {
      if (detailId() !== id || sec.querySelector(':scope > .nj-td')) return;
      var series = it.Type === 'Series' ? it.Id : null;
      bar = document.createElement('div');
      bar.className = 'nj-td';
      bar.setAttribute('data-id', id);
      bar.setAttribute('role', 'tablist');
      bar.innerHTML = (series ? '<button type="button" role="tab" data-nj-do="td" data-nj-id="eps">Episodes</button>' : '') +
        '<button type="button" role="tab" data-nj-do="td" data-nj-id="col">Collection</button>' +
        '<button type="button" role="tab" data-nj-do="td" data-nj-id="sim">More Like This</button>';
      sec.insertBefore(bar, sec.firstChild);
      if (series) {
        var eps = document.createElement('div');
        eps.className = 'nj-td-eps';
        eps.innerHTML = '<div class="nj-td-head"><label class="nj-eps-season"><select aria-label="Season"></select></label></div><ol class="nj-td-list"></ol>';
        sec.insertBefore(eps, bar.nextSibling);
        page.classList.add('nj-has-eps');
        var sel = eps.querySelector('select');
        sel.addEventListener('change', function () { tdLoad(eps, series, sel.value); });
        var a = api();
        a.getJSON(a.getUrl('Shows/' + series + '/Seasons', { userId: userId() })).then(function (r) {
          var ss = (r && r.Items) || [];
          sel.innerHTML = ss.map(function (s) { return '<option value="' + esc(s.Id) + '">' + esc(s.Name) + '</option>'; }).join('');
          var cur = ss.filter(function (s) { return s.UserData && !s.UserData.Played; })[0] || ss[0];
          if (cur) { sel.value = cur.Id; tdLoad(eps, series, cur.Id); }
        });
      } else page.classList.remove('nj-has-eps');
      tdPick(page, series ? 'eps' : 'sim');
    });
  }
  function tdRefresh(page, bar) {
    var col = page.querySelector('#collectionsCollapsible');
    var hasCol = !!col && !col.classList.contains('hide') && !!col.querySelector('.card');
    var b = bar.querySelector('[data-nj-id="col"]');
    if (b) b.hidden = !hasCol;
  }
  function tdPick(page, which) {
    page.setAttribute('data-nj-td', which);
    each(page.querySelectorAll('.nj-td [role="tab"]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-nj-id') === which)); });
  }
  function tdLoad(box, series, seasonId) {
    var a = api(), list = box.querySelector('.nj-td-list');
    a.getJSON(a.getUrl('Shows/' + series + '/Episodes', { seasonId: seasonId, userId: userId(), Fields: 'Overview', EnableUserData: true, EnableImageTypes: 'Primary', ImageTypeLimit: 1 })).then(function (r) {
      list.innerHTML = ((r && r.Items) || []).map(function (e) {
        var tag = e.ImageTags && e.ImageTags.Primary, mins = e.RunTimeTicks ? Math.round(e.RunTimeTicks / 6e8) + 'm' : '';
        var pct = e.UserData && (e.UserData.Played ? 100 : e.UserData.PlayedPercentage || 0);
        return '<li class="nj-tde"><button type="button" class="nj-tde-play" data-nj-do="play" data-nj-id="' + esc(e.Id) + '" aria-label="Play ' + esc(e.Name) + '">' +
          '<span class="nj-ep-img">' + (tag ? '<img alt="" loading="lazy" src="' + esc(imageUrl(e.Id, 'Primary', tag, 400)) + '">' : '') +
          '<i class="nj-tde-pi"></i>' + (pct ? '<i class="nj-ep-bar" style="--p:' + (pct / 100).toFixed(3) + '"></i>' : '') + '</span>' +
          '<span class="nj-tde-t">' + (e.IndexNumber != null ? e.IndexNumber + '. ' : '') + esc(e.Name) + '</span><span class="nj-tde-m">' + mins + '</span></button>' +
          (e.Overview ? '<p class="nj-tde-o">' + esc(e.Overview) + '</p>' : '') + '</li>';
      }).join('');
    });
  }
  // the title's trailer plays muted over the page's backdrop (a series' trailer on its seasons and episodes)
  function detailTrailer(page, id, tid) {
    each(page.querySelectorAll('.nj-dt'), function (x) { x.remove(); });
    if (reduced.matches) return;
    hasTrailer(tid).then(function (ok) {
      var bd = page.querySelector('.itemBackdrop');
      if (!ok || !bd || page.getAttribute('data-nj-bd') !== id) return;
      var v = document.createElement('video');
      v.className = 'nj-dt';
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('aria-hidden', 'true');
      v.src = TRAILERS + encodeURIComponent(tid) + '.mp4';
      v.addEventListener('playing', function () { v.classList.add('nj-dt--on'); });
      var s = document.createElement('button');
      s.type = 'button'; s.className = 'nj-dt nj-dt-sound'; s.setAttribute('aria-label', 'Trailer sound');
      s.innerHTML = ICON.mute + ICON.vol;
      s.addEventListener('click', function (e) { e.stopPropagation(); v.muted = !v.muted; s.classList.toggle('nj-on', !v.muted); });
      bd.appendChild(v); bd.appendChild(s);
      setTimeout(function () { if (v.isConnected) v.play().catch(function () {}); }, 1200);
    });
  }
  function syncDetail() {
    var page = document.querySelector('.itemDetailPage:not(.hide)');
    each(document.querySelectorAll('.itemDetailPage.hide video.nj-dt'), function (v) { v.pause(); });
    if (!NJ.detailBackdrop || !visible(page)) return null;
    var id = detailId();
    if (id && page.getAttribute('data-nj-bd') !== id) {
      // Jellyfin reuses one detail view for the next item and rewrites it in place:
      // hide the info column again until the new title is in
      var nm = page.querySelector('.nameContainer');
      page.njPrevTitle = nm ? nm.textContent.trim() : '';
      page.classList.remove('nj-ready');
      page.setAttribute('data-nj-t0', String(Date.now()));
      setTimeout(schedule, 1250);
      page.setAttribute('data-nj-bd', id);
      page.classList.remove('nj-no-bd');
      page.style.removeProperty('--nj-bd');
      getItem(id).then(function (it) {
        if (page.getAttribute('data-nj-bd') !== id) return;
        var url = backdropOf(it, 1920);
        if (url) page.style.setProperty('--nj-bd', 'url("' + url + '")');
        else page.classList.add('nj-no-bd');
        detailTrailer(page, id, it.SeriesId || it.Id);
      }, function () { page.classList.add('nj-no-bd'); });
    }
    // A new detail view paints an empty title block first and fills it ~200 ms later, which
    // pushed everything below down. Keep the info column hidden until the title is in
    // (or 1.2 s passed), so it appears once, in place.
    if (!page.classList.contains('nj-ready')) {
      var seen = +page.getAttribute('data-nj-t0') || 0;
      if (!seen) { seen = Date.now(); page.setAttribute('data-nj-t0', String(seen)); setTimeout(schedule, 1250); }
      var name = page.querySelector('.nameContainer'), title = name ? name.textContent.trim() : '';
      if ((title && title !== (page.njPrevTitle || '')) || Date.now() - seen > 1200) page.classList.add('nj-ready');
    }
    // a visible label on Play, taken from Jellyfin's own (localized) title: "Play" or "Resume"
    var pb = page.querySelector('.mainDetailButtons .btnPlay .detailButton-content');
    if (pb) {
      var lab = pb.querySelector('.nj-btn-label'), want = pb.parentNode.title || 'Play';
      if (!lab) { lab = document.createElement('span'); lab.className = 'nj-btn-label'; pb.appendChild(lab); }
      if (lab.textContent !== want) lab.textContent = want;
    }
    // the poster card was display:none, so the lazy loader may never have filled it
    syncTitleTabs(page);
    // phones: a small label under each action icon
    var LBL = { btnPlayTrailer: 'Trailer', btnShuffle: 'Shuffle', btnPlaystate: 'Watched', btnUserRating: 'My List', btnMoreCommands: 'More', btnDownload: 'Download', btnInstantMix: 'Mix' };
    each(page.querySelectorAll('.mainDetailButtons .detailButton'), function (bt) {
      if (bt.querySelector('.nj-act-l')) return;
      for (var k in LBL) if (bt.classList.contains(k)) { var sp = document.createElement('span'); sp.className = 'nj-act-l'; sp.textContent = LBL[k]; bt.appendChild(sp); break; }
    });
    var img = page.querySelector('.detailPagePrimaryContainer > .detailImageContainer .cardImageContainer[data-src]');
    if (img && !img.style.backgroundImage) img.style.backgroundImage = 'url("' + img.getAttribute('data-src') + '")';
    return page;
  }

  /* ============ PROFILES: "Who's watching?" ============
     One household login (config `household`) plus viewing profiles with no
     password. The picker opens after every sign-in, on the first load of each
     browser session (sessionStorage nj-who) and from "Switch profile" in the
     user menu. A profile signs in through ApiClient.authenticateUserByName, the
     call the login page makes, so the app updates its own credential store;
     then Home reloads so no screen keeps the last user's data. Before leaving
     the household login, its credentials entry is copied to localStorage
     nj-household so the Household tile can return without a password.
     localStorage nj-profiles caches ids and image tags from an admin's user list
     (no secrets). Jellyfin's HasPassword flag stays true after a reset, so it is
     ignored: a profile is locked only when its sign-in really returns 401, and
     is then not retried (three failed sign-ins disable a Jellyfin user) until
     an admin next loads the app, which rebuilds the cache. */
  var WHO = { el: null, html: '', me: null, meId: null, busy: false, back: null, inerted: [], listed: false };
  var SIGNIN_ROUTE = /^#!?\/(login|selectserver|addserver|forgotpassword|wizard|startup)/i;
  var VIDEO_ROUTE = /^#!?\/video/i;
  var BACK_KEYS = { Escape: 1, GoBack: 1, BrowserBack: 1, XF86Back: 1, Backspace: 1 };
  var SAY = {
    net: 'Couldn’t reach the server. Check the connection, then try again.',
    pw: function (n) { return n + ' still has a password. Clear it in Dashboard › Users, then pick ' + n + ' again.'; },
    noHome: function () { return 'This device has no household sign-in saved. Sign out, then sign in as ' + (HOUSEHOLD || 'the household account') + '.'; },
    oldHome: function () { return 'The household sign-in has expired. Sign out, then sign in as ' + (HOUSEHOLD || 'the household account') + '.'; }
  };

  function sess(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { /* storage off */ }
    return null;
  }
  function readJson(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  // the ApiClient's user once it is up; the saved credentials before that
  function signedInId() {
    var id = userId();
    if (id) return id;
    var c = readJson('jellyfin_credentials'), s = c && c.Servers && c.Servers[0];
    return s && s.AccessToken && s.UserId ? s.UserId : null;
  }
  function profileHue(name) {
    var n = String(name || '').toLowerCase(), l = PROFILES;
    for (var i = 0; i < l.length; i++) if (l[i][0].toLowerCase() === n) return l[i][1];
    return null;
  }
  function initialOf(name) { return String(name || '?').trim().charAt(0).toUpperCase(); }
  function known() { return readJson('nj-profiles') || {}; }

  function tileHtml(name, current) {
    var k = known()[name] || {}, a = api();
    var img = k.tag && a && a.getUserImageUrl ? '<img class="nj-who-img" alt="" src="' + esc(a.getUserImageUrl(k.id, { type: 'Primary', tag: k.tag, maxWidth: 400 })) + '">' : '';
    return '<li><button type="button" class="nj-who-p" data-nj-do="who" data-nj-name="' + esc(name) + '" style="--nj-h:' + profileHue(name) + '"' +
      (current ? ' aria-current="true"' : '') + (k.pw ? ' aria-label="' + esc(name) + ', has a password"' : '') + '>' +
      '<span class="nj-who-av"><span class="nj-who-i" aria-hidden="true">' + esc(initialOf(name)) + '</span>' + img + '</span>' +
      '<span class="nj-who-n">' + esc(name) + (k.pw ? ICON.lock : '') + '</span></button></li>';
  }
  function homeTileHtml(current, name) {
    var sub = name && HOUSEHOLD && name.toLowerCase() === HOUSEHOLD.toLowerCase() ? name : ''; // any other shared login stays unnamed
    return '<li><button type="button" class="nj-who-p nj-who-p--home" data-nj-do="who" data-nj-name=""' + (current ? ' aria-current="true"' : '') +
      ' aria-label="Household' + (sub ? ', ' + esc(sub) : '') + '"><span class="nj-who-av">' + ICON.home + '</span>' +
      '<span class="nj-who-n">Household</span>' + (sub ? '<span class="nj-who-sub">' + esc(sub) + '</span>' : '') + '</button></li>';
  }
  function whoRender() {
    if (!WHO.el) return;
    var k = known(), meId = signedInId(), me = WHO.me ? WHO.me.Name : null, hh = readJson('nj-household'), html = '';
    if (!me) for (var n in k) if (k[n].id === meId) me = n;
    var meProfile = me != null && profileHue(me) != null;
    PROFILES.forEach(function (p) { html += tileHtml(p[0], meProfile && me.toLowerCase() === p[0].toLowerCase()); });
    // Household shows unless this is a profile session with nothing to return to
    if (!(meProfile && !hh)) html += homeTileHtml(me != null && !meProfile, me != null && !meProfile ? me : hh ? hh.Name : HOUSEHOLD);
    WHO.el.querySelector('.nj-who-manage').hidden = !(WHO.me && WHO.me.admin);
    if (html === WHO.html) return;
    var f = document.activeElement, keep = f && WHO.el.contains(f) ? f.getAttribute('data-nj-name') : null;
    var grid = WHO.el.querySelector('.nj-who-grid');
    grid.innerHTML = WHO.html = html;
    each(grid.querySelectorAll('.nj-who-img'), function (im) {
      if (im.complete && im.naturalWidth) im.classList.add('nj-ld');
      else im.addEventListener('load', function () { im.classList.add('nj-ld'); });
    });
    if (keep != null) whoFocus(keep);
  }
  function whoFocus(name) {
    if (!WHO.el) return;
    var list = WHO.el.querySelectorAll('.nj-who-p'), pick = null;
    each(list, function (b) { if (!pick && name != null && b.getAttribute('data-nj-name') === name) pick = b; });
    pick = pick || WHO.el.querySelector('.nj-who-p[aria-current="true"]') || list[0];
    if (pick && document.activeElement !== pick) pick.focus({ preventScroll: true });
  }
  function whoInert() {
    each(document.body.children, function (c) {
      if (c === WHO.el || c.hasAttribute('inert') || /^(SCRIPT|STYLE|LINK)$/.test(c.tagName)) return;
      c.setAttribute('inert', '');
      WHO.inerted.push(c);
    });
  }
  function whoOpen() {
    if (WHO.el || !document.body) return;
    var el = document.createElement('div');
    el.className = 'nj-who';
    el.tabIndex = -1;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'nj-who-t');
    el.innerHTML = '<div class="nj-who-in"><h2 class="nj-who-t" id="nj-who-t">Who’s watching?</h2><ul class="nj-who-grid"></ul>' +
      '<p class="nj-who-msg" role="status" aria-live="polite"></p><a class="nj-who-manage" href="#/dashboard/users" hidden>Manage profiles</a></div>';
    el.addEventListener('keydown', whoKey);
    WHO.back = document.activeElement;
    WHO.el = el; WHO.html = '';
    document.body.appendChild(el);
    root.classList.add('nj-who-open');
    whoInert();
    if (PV.slide) pvStop(); else clearTimeout(PV.timer);
    whoRender();
    setTimeout(function () { whoFocus(null); }, 60); // after a closing MUI menu hands focus back
  }
  function whoClose(done) {
    var el = WHO.el;
    if (!el) return;
    if (done) sess('nj-who', '1');
    WHO.el = null; WHO.busy = false;
    WHO.inerted.forEach(function (c) { c.removeAttribute('inert'); });
    WHO.inerted = [];
    root.classList.remove('nj-who-open');
    el.classList.add('nj-who--out');
    setTimeout(function () { el.remove(); }, reduced.matches ? 0 : 300);
    if (WHO.back && WHO.back.isConnected && WHO.back.focus) WHO.back.focus({ preventScroll: true });
    pvArm();
    schedule();
  }
  function whoKey(e) {
    e.stopPropagation(); // Jellyfin's own key handling stays behind the picker
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (NAV_KEYS[e.key]) {
      e.preventDefault();
      var cur = document.activeElement, list = focusables(WHO.el);
      var next = cur && cur !== WHO.el && WHO.el.contains(cur) ? nearest(cur, e.key, list) : list[0];
      if (next) next.focus();
    } else if ((BACK_KEYS[e.key] || e.keyCode === 461 || e.keyCode === 10009) && !WHO.busy) {
      e.preventDefault(); // TV Back / Escape: carry on as the current user
      whoClose(true);
    }
  }
  function whoSay(msg) { var m = WHO.el && WHO.el.querySelector('.nj-who-msg'); if (m) m.textContent = msg; }
  function whoBusy(btn) {
    WHO.busy = !!btn;
    if (!WHO.el) return;
    WHO.el.setAttribute('aria-busy', String(!!btn));
    each(WHO.el.querySelectorAll('.nj-busy'), function (b) { b.classList.remove('nj-busy'); });
    if (btn) { btn.classList.add('nj-busy'); whoSay(''); }
  }
  function whoLeave(btn) {
    sess('nj-who', '1');
    if (WHO.el) { WHO.el.classList.add('nj-who--go'); btn.classList.add('nj-who-p--go'); }
    // a fresh page is the only state with nothing left over from the last user
    setTimeout(function () { location.replace(location.href.split('#')[0] + '#/home'); location.reload(); }, reduced.matches ? 0 : 450);
  }
  // the account on screen is not a viewing profile, so it is the household login: keep its entry
  function keepHousehold(a) {
    return Promise.resolve(WHO.me || a.getCurrentUser()).then(function (u) {
      if (!u || profileHue(u.Name) != null) return;
      store.set('nj-household', JSON.stringify({ ServerId: a.serverId(), UserId: u.Id, Name: u.Name, AccessToken: a.accessToken() }));
    });
  }
  function markPassword(name) {
    var k = known();
    k[name] = k[name] || {};
    k[name].pw = true;
    store.set('nj-profiles', JSON.stringify(k));
    whoRender();
  }
  function whoPick(btn) {
    var name = btn.getAttribute('data-nj-name'), a = api();
    if (WHO.busy || !WHO.el || !a) return;
    if (btn.getAttribute('aria-current') === 'true') { whoClose(true); return; }
    if (!name) { whoHousehold(btn, a); return; }
    if ((known()[name] || {}).pw) { whoSay(SAY.pw(name)); return; }
    whoBusy(btn);
    keepHousehold(a)
      .then(function () { return a.authenticateUserByName(name, ''); })
      .then(function () { whoLeave(btn); }, function (r) {
        whoBusy(null);
        if (r && r.status === 401) { markPassword(name); whoSay(SAY.pw(name)); } else whoSay(SAY.net);
      });
  }
  function whoHousehold(btn, a) {
    var h = readJson('nj-household');
    if (!h || !h.AccessToken) { whoSay(SAY.noHome()); return; }
    whoBusy(btn);
    fetch(a.getUrl('Users/Me'), { headers: { Authorization: 'MediaBrowser Token="' + h.AccessToken + '"' } })
      .then(function (r) { if (!r.ok) throw r; return r.json(); })
      .then(function (u) {
        if (u.Id !== h.UserId) throw { status: 401 };
        // the call a sign-in ends with: the app stores the credentials itself
        return a.onAuthenticated(a, { ServerId: h.ServerId, AccessToken: h.AccessToken, User: u });
      })
      .then(function () { whoLeave(btn); }, function (r) {
        whoBusy(null);
        if (r && r.status === 401) { store.set('nj-household', null); whoRender(); whoSay(SAY.oldHome()); } else whoSay(SAY.net);
      });
  }
  function listProfiles() {
    if (WHO.listed) return;
    WHO.listed = true;
    api().getUsers().then(function (users) {
      var k = {};
      PROFILES.forEach(function (p) {
        users.forEach(function (u) {
          if (u.Name.toLowerCase() === p[0].toLowerCase()) k[p[0]] = { id: u.Id, tag: u.PrimaryImageTag || null };
        });
      });
      store.set('nj-profiles', JSON.stringify(k));
      whoRender();
    }, function () { WHO.listed = false; });
  }
  // header avatar: the current profile's initial on its colour (a user picture still wins)
  function syncAvatar() {
    var u = WHO.me, av = document.querySelector('header.MuiAppBar-root .MuiAvatar-root');
    if (!u || !av || av.getAttribute('data-nj-who') === u.Name) return;
    var hue = profileHue(u.Name);
    av.setAttribute('data-nj-who', u.Name);
    av.setAttribute('data-nj-i', initialOf(u.Name));
    av.setAttribute('data-nj-prof', hue != null ? '1' : '0');
    if (hue != null) av.style.setProperty('--nj-h', hue); else av.style.removeProperty('--nj-h');
  }
  // "Switch profile" at the top of the user menu, built from the menu's own item classes
  function syncUserMenu() {
    var m = document.querySelector('#app-user-menu [role="menu"]');
    var ref = m && m.querySelector('[role="menuitem"]');
    if (!ref || m.querySelector('.nj-switch') || (!PROFILES_ON && !AVATARS)) return;
    var cls = function (sel) { var x = ref.querySelector(sel); return esc(x ? x.className : ''); };
    var li = document.createElement('li');
    li.className = ref.className.replace(/\s*Mui-focusVisible/g, '') + ' nj-switch';
    li.setAttribute('role', 'menuitem');
    li.setAttribute('data-nj-do', 'who-open');
    li.tabIndex = -1;
    li.innerHTML = '<div class="' + cls('.MuiListItemIcon-root') + '">' + ICON.swap + '</div><div class="' + cls('.MuiListItemText-root') + '">' +
      '<span class="' + cls('.MuiListItemText-primary') + '">Switch profile</span></div>';
    li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); } });
    if (PROFILES_ON) m.insertBefore(li, ref);
    if (!AVATARS) return;
    var av = document.createElement('li');
    av.className = li.className.replace('nj-switch', 'nj-switch nj-avmenu');
    av.setAttribute('role', 'menuitem');
    av.setAttribute('data-nj-do', 'avatar-open');
    av.tabIndex = -1;
    av.innerHTML = '<div class="' + cls('.MuiListItemIcon-root') + '"><svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.6"/><path d="M4.8 20c.7-3.6 3.5-5.6 7.2-5.6s6.5 2 7.2 5.6"/></svg></div><div class="' + cls('.MuiListItemText-root') + '">' +
      '<span class="' + cls('.MuiListItemText-primary') + '">Change avatar</span></div>';
    av.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); av.click(); } });
    m.insertBefore(av, ref);
  }
  function whoSync() {
    syncUserMenu();
    if (!PROFILES_ON) return;
    var id = signedInId(), signin = !id || SIGNIN_ROUTE.test(location.hash);
    if (signin) sess('nj-who', null); // so the next sign-in opens the picker
    if (signin || VIDEO_ROUTE.test(location.hash)) { whoClose(false); return; }
    var aid = userId();
    if (aid && aid !== WHO.meId) {
      WHO.meId = aid; WHO.me = null;
      api().getCurrentUser().then(function (u) {
        if (!u || u.Id !== WHO.meId) return;
        WHO.me = { Id: u.Id, Name: u.Name, admin: !!(u.Policy && u.Policy.IsAdministrator) };
        if (WHO.me.admin) listProfiles();
        whoRender();
        syncAvatar();
      }, function () { WHO.meId = null; });
    }
    syncAvatar();
    if (WHO.el) whoInert();
    else if (!sess('nj-who')) whoOpen();
  }

  /* ============ REMOTE / D-PAD ============
     Jellyfin's TV layout has its own focus manager. In the desktop layouts a TV
     remote's arrows would only scroll, so this is a fallback: if an arrow press
     did not move focus and nobody called preventDefault, move focus to the
     nearest focusable element in that direction. Enter is native: every target
     is a <button> or <a>. html.nj-kbd turns on the focus rings. */
  var NAV_KEYS = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
  var FOCUSABLE = 'button:not([disabled]), a[href], input:not([type="hidden"]), select, [tabindex]:not([tabindex="-1"])';
  var NAV_SKIP = '.cardOverlayContainer, .cardText, .emby-scrollbuttons, [inert], .hide';

  function focusables(scope) {
    var out = [];
    if (!scope) return out;
    each(scope.querySelectorAll(FOCUSABLE), function (el) {
      if (el.offsetParent === null || el.closest(NAV_SKIP)) return;
      var r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) out.push(el);
    });
    return out;
  }
  // tiers: an open dialog alone; otherwise the page first, the fixed header only
  // when nothing in the page lies that way (the header overlaps scrolled content)
  function navTiers() {
    if (WHO.el) return [focusables(WHO.el)];
    var dlg = document.querySelector('.dialogContainer .dialog:not(.hide), .MuiDialog-root .MuiDialog-paper');
    if (dlg) return [focusables(dlg)];
    return [focusables(document.querySelector('.page:not(.hide)')), focusables(headerEl())];
  }
  function nearest(cur, key, list) {
    var r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bd = Infinity;
    list.forEach(function (el) {
      if (el === cur || cur.contains(el)) return;
      var q = el.getBoundingClientRect(), dx = q.left + q.width / 2 - cx, dy = q.top + q.height / 2 - cy, d;
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        if (key === 'ArrowRight' ? dx <= 4 : dx >= -4) return;
        if (q.bottom < r.top + 4 || q.top > r.bottom - 4) return; // same visual line only
        d = Math.abs(dx) + Math.abs(dy) * 3;
      } else {
        if (key === 'ArrowDown' ? q.top < r.bottom - 4 : q.bottom > r.top + 4) return;
        d = Math.abs(dy) + Math.abs(dx) * 1.6;
      }
      if (d < bd) { bd = d; best = el; }
    });
    return best;
  }
  function navMove(key) {
    var cur = document.activeElement;
    var tiers = navTiers();
    if (!cur || cur === document.body) {
      var first = (!WHO.el && HERO.el && visible(HERO.el) && HERO.el.querySelector('.nj-hero-slide.nj-on .nj-btn')) || tiers[0][0];
      if (first) first.focus();
      return;
    }
    var best = null;
    for (var i = 0; i < tiers.length && !best; i++) best = nearest(cur, key, tiers[i]);
    if (!best) return;
    best.focus({ preventScroll: true });
    if (HERO.el && HERO.el.contains(best)) window.scrollTo(0, 0);
    else if (!best.closest('header, .skinHeader')) best.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
  }
  window.addEventListener('keydown', function (e) {
    if (NAV_KEYS[e.key] || e.key === 'Enter' || e.key === 'Tab') root.classList.add('nj-kbd');
    if (!NAV_KEYS[e.key] || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.videoPlayerContainer:not(.hide), .videoOsdBottom:not(.hide)')) return; // player owns the keys
    var before = document.activeElement;
    setTimeout(function () {
      if (e.defaultPrevented || document.activeElement !== before) return; // Jellyfin handled it
      navMove(e.key);
    }, 0);
  }, true);
  window.addEventListener('pointerdown', function () { root.classList.remove('nj-kbd'); }, true);

  /* ============ AVATAR LIBRARY ============
     "Change avatar" in the user menu opens a grid of pictures kept on this server in
     the avatars.base folder (index.json lists the files). A pick becomes the signed-in user's own
     Jellyfin profile picture, so the header, the profile picker and every app show it. */
  var AV = { el: null };
  function avSay(m) { var p = AV.el && AV.el.querySelector('.nj-av-msg'); if (p) p.textContent = m; }
  function avClose() {
    if (AV.el) { AV.el.remove(); AV.el = null; }
    root.classList.remove('nj-av-open');
  }
  function avOpen() {
    if (AV.el) return;
    var el = document.createElement('div');
    el.className = 'nj-av';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Choose your avatar');
    el.innerHTML = '<div class="nj-av-in"><div class="nj-av-top"><h2 class="nj-av-t">Choose your avatar</h2>' +
      '<button type="button" class="nj-av-x" data-nj-do="avatar-close" aria-label="Close">&times;</button></div>' +
      '<ul class="nj-av-grid"></ul><p class="nj-av-msg" role="status" aria-live="polite"></p></div>';
    document.body.appendChild(el);
    AV.el = el;
    root.classList.add('nj-av-open');
    if (!AVATARS) return;
    fetch(AVATARS + 'index.json').then(function (r) { return r.json(); }).then(function (list) {
      el.querySelector('.nj-av-grid').innerHTML = list.map(function (f) {
        return '<li><button type="button" class="nj-av-b" data-nj-do="avatar-pick" data-nj-id="' + esc(f) + '"><img alt="" loading="lazy" src="' + esc(AVATARS + f) + '"></button></li>';
      }).join('');
    }).catch(function () { avSay('Could not load the avatars.'); });
  }
  function avPick(file) {
    var a = api(), id = a && a.getCurrentUserId && a.getCurrentUserId(), tok = a && a.accessToken && a.accessToken();
    if (!id || !tok || !file) { avSay('Sign in first.'); return; }
    avSay('Saving...');
    var auth = { Authorization: 'MediaBrowser Token="' + tok + '"' };
    // Jellyfin 12 takes the picture as base64 text (a raw binary body answers 500)
    if (!AVATARS) return;
    fetch(AVATARS + encodeURIComponent(file)).then(function (r) { return r.blob(); }).then(function (blob) {
      return new Promise(function (ok, fail) {
        var fr = new FileReader();
        fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); };
        fr.onerror = fail;
        fr.readAsDataURL(blob);
      });
    }).then(function (b64) {
      return fetch(a.getUrl('UserImage', { userId: id }), { method: 'POST', headers: { Authorization: auth.Authorization, 'Content-Type': 'image/png' }, body: b64 });
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return fetch(a.getUrl('Users/Me'), { headers: auth }).then(function (m) { return m.json(); });
    }).then(function (me) {
      var k = readJson('nj-profiles') || {};
      if (me && me.Name && k[me.Name]) { k[me.Name].tag = me.PrimaryImageTag; store.set('nj-profiles', JSON.stringify(k)); }
      avSay('Saved.');
      setTimeout(function () { location.reload(); }, 350);
    }).catch(function () { avSay('Could not save. Try again.'); });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && AV.el) avClose(); });

  /* ============ CLICKS ============ */
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-nj-do]') : null;
    if (!t) return;
    var act = t.getAttribute('data-nj-do'), id = t.getAttribute('data-nj-id');
    if (act === 'theme') {
      var t0 = themePref();
      store.set('nj-theme', MODES[(MODES.indexOf(t0) + 1) % MODES.length] === 'auto' ? null : MODES[(MODES.indexOf(t0) + 1) % MODES.length]);
      applyTheme();
    } else if (act === 'go') {
      showSlide(+id);
    } else if (act === 'sound') {
      var want = PV.video ? PV.video.muted : !soundWanted();
      store.set('nj-sound', want ? 'on' : 'off');
      if (PV.video) PV.video.muted = !want;
      syncSoundButton();
    } else if (act === 'play') {
      e.preventDefault();
      play(id);
    } else if (act === 't10') {
      var tr = t.closest('.nj-top10').querySelector('.nj-t10-track');
      tr.scrollBy({ left: (+id) * tr.clientWidth * 0.8, behavior: reduced.matches ? 'auto' : 'smooth' });
    } else if (act === 'rq-open') {
      if (RQ.list && RQ.list[+id]) rqpOpen(RQ.list[+id], t);
    } else if (act === 'rqp-close') {
      rqpClose();
    } else if (act === 'rqp-go') {
      rqpGo(t);
    } else if (act === 'rqp-all') {
      each(RQP.el.querySelectorAll('.nj-rqp-s input:not(:disabled)'), function (c) { c.checked = true; });
    } else if (act === 'upd-reload') {
      updReload();
    } else if (act === 'rq-my') {
      RQ.myOpen = !RQ.myOpen; rqMyRender();
    } else if (act === 'rq-cancel') {
      rqCancel(t);
    } else if (act === 'who') {
      whoPick(t);
    } else if (act === 'cw-menu') {
      e.preventDefault();
      cwMenu(t);
    } else if (act === 'td') {
      tdPick(t.closest('.itemDetailPage'), id);
    } else if (act === 'back') {
      if (history.length > 1) history.back(); else location.hash = '#/home';
    } else if (act === 'cats') {
      catsOpen();
    } else if (act === 'cw-close') {
      cwClose();
    } else if (act === 'cw-played') {
      cwPlayed(id);
    } else if (act === 'as-close') {
      asClose();
    } else if (act === 'as-pick') {
      asPick(t);
    } else if (act === 'eps') {
      if (EPS.el) epsClose(); else epsOpen();
    } else if (act === 'eps-close') {
      epsClose();
    } else if (act === 'ep') {
      var epId = id;
      epsClose();
      if (EPS.item && epId === EPS.item.Id) return;
      EPS.item = null;
      play(epId);
    } else if (act === 'me') {
      profOpen();
    } else if (act === 'prof-go') {
      profGo(id);
    } else if (act === 'prof-switch') {
      profSwitch(id);
    } else if (act === 'fav') {
      e.preventDefault();
      toggleFav(t);
    } else if (act === 'avatar-open') {
      cwClose();
      var bd2 = document.querySelector('#app-user-menu .MuiBackdrop-root');
      if (bd2) bd2.click();
      avOpen();
    } else if (act === 'avatar-close') {
      avClose();
    } else if (act === 'avatar-pick') {
      avPick(id);
    } else if (act === 'who-open') {
      var bd = document.querySelector('#app-user-menu .MuiBackdrop-root');
      if (bd) bd.click(); // close the user menu first
      whoOpen();
    }
  });

  /* ============ REQUESTS (Seerr) ============ */
  // Search page: below Jellyfin's own results, titles that are not in the library, with a
  // Request button. Goes through requests.base (a proxy that checks the Jellyfin sign-in and
  // adds the Seerr key); a request only creates a Seerr request, which hands off to Radarr/Sonarr.
  var RQ_ALT = NJ.requests && isObj(NJ.requests.extraProfile) && NJ.requests.extraProfile.profileId != null ? NJ.requests.extraProfile : null;
  var RQ = { q: '', timer: null, el: null, cache: {}, busy: {} };
  function rqHeaders() {
    var a = api(), t = a && a.accessToken && a.accessToken();
    return t ? { Authorization: 'MediaBrowser Token="' + t + '"' } : null;
  }
  function rqFetch(path, opts) {
    var h = rqHeaders();
    if (!h) return Promise.reject(new Error('not signed in'));
    opts = opts || {};
    opts.headers = Object.assign(h, opts.headers || {});
    return fetch(REQ_BASE + path, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function rqStatusOf(r) { return r.mediaInfo ? r.mediaInfo.status : 1; }
  // Seerr media status: 1 unknown, 2 pending, 3 processing, 4 partly available, 5 available, 7 deleted
  function rqCanRequest(st) { return st <= 1 || st === 7; }
  var RQ_DL = '<svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v10M7.5 11l4.5 4.5 4.5-4.5M6.5 19h11"/></svg>';
  function rqBadge(st) {
    var t = st === 4 ? 'Partly in library' : st === 2 ? 'Requested' : st === 3 ? 'Downloading' : '';
    return t ? '<span class="nj-rq-badge">' + t + '</span>' : '';
  }
  // One poster card. In the library: opens the Jellyfin item. Otherwise opens the request popup.
  function rqCard(r, i) {
    var title = r.title || r.name || '', year = (r.releaseDate || r.firstAirDate || '').slice(0, 4), st = rqStatusOf(r);
    var jf = st === 5 && r.mediaInfo && r.mediaInfo.jellyfinMediaId;
    var img = r.posterPath ? '<img alt="" decoding="async" src="https://image.tmdb.org/t/p/w342' + esc(r.posterPath) + '">' : '<span class="nj-rq-noimg">' + esc(title) + '</span>';
    var inner = '<span class="nj-rq-poster">' + img + (rqCanRequest(st) ? '<span class="nj-rq-dl">' + RQ_DL + '</span>' : rqBadge(st)) + '</span>' +
      '<span class="nj-rq-t">' + esc(title) + '</span><span class="nj-rq-m">' + esc(year) + (year ? ' · ' : '') + (r.mediaType === 'tv' ? 'Show' : 'Movie') + '</span>';
    return jf
      ? '<a class="nj-rq-card" href="' + esc(detailsHash(jf)) + '">' + inner + '</a>'
      : '<button type="button" class="nj-rq-card" data-nj-do="rq-open" data-nj-id="' + i + '" aria-label="' + esc((rqCanRequest(st) ? 'Request ' : '') + title + (year ? ' (' + year + ')' : '')) + '">' + inner + '</button>';
  }
  function rqRender(results, q) {
    if (!RQ.el || RQ.q !== q) return;
    var seen = {};
    var list = results.filter(function (r) {
      var k = r.mediaType + ':' + r.id;
      if ((r.mediaType !== 'movie' && r.mediaType !== 'tv') || seen[k]) return false;
      return (seen[k] = true);
    }).slice(0, 40);
    RQ.list = list;
    RQ.res.innerHTML = list.length
      ? '<h2 class="nj-rq-h">More titles</h2><div class="nj-rq-grid">' + list.map(rqCard).join('') + '</div>'
      : '';
  }
  // Seerr returns 20 results a page, people included: read up to 3 pages for ~40 titles.
  function rqSearch(q) {
    RQ.q = q;
    if (q.length < 2) { if (RQ.res) RQ.res.innerHTML = ''; return; }
    var page = function (n) { return rqFetch('search?query=' + encodeURIComponent(q) + '&page=' + n).catch(function () { return { results: [], totalPages: 0 }; }); };
    var titles = function (rs) { return rs.filter(function (r) { return r.mediaType === 'movie' || r.mediaType === 'tv'; }); };
    var hit = RQ.cache[q];
    (hit ? Promise.resolve(hit) : page(1).then(function (p1) {
      if ((p1.totalPages || 0) < 2) return p1.results || [];
      return page(2).then(function (p2) {
        var all = (p1.results || []).concat(p2.results || []);
        if (titles(all).length >= 40 || (p1.totalPages || 0) < 3) return all;
        return page(3).then(function (p3) { return all.concat(p3.results || []); });
      });
    }).then(function (all) { return (RQ.cache[q] = all); }))
      .then(function (res) { rqRender(res, q); }, function () { if (RQ.res && RQ.q === q) RQ.res.innerHTML = ''; });
  }
  function syncRequests() {
    if (!NJ.requests || !NJ.requests.enabled) return;
    var page = document.getElementById('searchPage');
    if (!page || page.classList.contains('hide')) { RQ.el = null; return; }
    if (!RQ.el || !RQ.el.isConnected) {
      RQ.el = document.createElement('section');
      RQ.el.className = 'nj-rq padded-left padded-right';
      RQ.el.innerHTML = '<div class="nj-rq-bar"><button type="button" class="nj-rq-link" data-nj-do="rq-my">My requests</button></div><div class="nj-rq-res"></div><div class="nj-rq-my"></div>';
      RQ.res = RQ.el.querySelector('.nj-rq-res'); RQ.my = RQ.el.querySelector('.nj-rq-my'); RQ.myOpen = false;
      RQ.q = '';
    }
    if (RQ.el.parentNode !== page || page.lastElementChild !== RQ.el) page.appendChild(RQ.el);
    var inp = page.querySelector('#searchTextInput'), q = inp ? inp.value.trim() : '';
    if (q !== RQ.q) {
      clearTimeout(RQ.timer);
      RQ.timer = setTimeout(function () { rqSearch(q); }, 450);
      RQ.q = q; // so the observer does not re-arm on every mutation
      if (!q && RQ.res) RQ.res.innerHTML = '';
    }
  }
  // My requests: what was asked for, where it stands, and a two-step Cancel. Cancel removes the
  // Seerr request only; a download Sonarr/Radarr already started keeps going until removed there.
  var RQM = { info: {} };
  function rqInfo(r) {
    var k = r.type + '/' + r.media.tmdbId;
    if (!RQM.info[k]) RQM.info[k] = rqFetch(k).then(function (d) { return { name: d.title || d.name || '', poster: d.posterPath, year: (d.releaseDate || d.firstAirDate || '').slice(0, 4), dl: ((d.mediaInfo && d.mediaInfo.downloadStatus) || []) }; }, function () { delete RQM.info[k]; return { name: '?', dl: [] }; });
    return RQM.info[k];
  }
  function rqState(r, dl) {
    var m = r.media.status;
    if (r.status === 3) return 'Declined';
    if (r.status === 4) return 'Failed';
    if (r.status === 1) return 'Waiting for approval';
    if (m === 5) return 'In your library';
    if (m === 4) return 'Partly in library';
    if (dl.length && dl[0].size) return 'Downloading ' + Math.round(100 - 100 * dl[0].sizeLeft / dl[0].size) + '%';
    return 'Requested: searching or downloading';
  }
  function rqMyRender() {
    if (!RQ.my) return;
    if (!RQ.myOpen) { RQ.my.innerHTML = ''; return; }
    RQ.my.innerHTML = '<h2 class="nj-rq-h">My requests</h2><div class="nj-rq-list">Loading…</div>';
    rqFetch('requests').then(function (d) {
      var rows = d.results || [];
      return Promise.all(rows.map(rqInfo)).then(function (infos) {
        if (!RQ.my || !RQ.myOpen) return;
        var box = RQ.my.querySelector('.nj-rq-list');
        box.innerHTML = rows.length ? rows.map(function (r, i) {
          var f = infos[i], inLib = r.media.status === 5;
          var seasons = r.type === 'tv' && r.seasons && r.seasons.length ? ' · Season ' + r.seasons.map(function (s) { return s.seasonNumber; }).join(', ') : '';
          return '<div class="nj-rq-line"><div class="nj-rq-thumb">' + (f.poster ? '<img alt="" src="https://image.tmdb.org/t/p/w92' + esc(f.poster) + '">' : '') + '</div>' +
            '<div class="nj-rq-info"><div class="nj-rq-t">' + esc(f.name) + (f.year ? ' (' + esc(f.year) + ')' : '') + esc(seasons) + '</div><div class="nj-rq-m">' + esc(rqState(r, f.dl)) + '</div></div>' +
            (inLib ? '' : '<button type="button" class="nj-rq-btn nj-rq-cancel" data-nj-do="rq-cancel" data-nj-id="' + r.id + '">Cancel</button>') + '</div>';
        }).join('') : 'No requests yet.';
      });
    }).catch(function () { var b = RQ.my && RQ.my.querySelector('.nj-rq-list'); if (b) b.textContent = 'Could not load requests.'; });
  }
  function rqCancel(btn) {
    if (btn.getAttribute('data-sure') !== '1') {
      btn.setAttribute('data-sure', '1'); btn.textContent = 'Remove request?';
      setTimeout(function () { if (btn.isConnected) { btn.removeAttribute('data-sure'); btn.textContent = 'Cancel'; } }, 4000);
      return;
    }
    btn.textContent = 'Removing…';
    rqFetch('request/' + btn.getAttribute('data-nj-id'), { method: 'DELETE' }).catch(function (e) { if (!/Unexpected|JSON/.test(String(e))) throw e; })
      .then(function () { rqMyRender(); }, function () { btn.textContent = 'Failed, try again'; });
  }
  // Request popup: backdrop, poster, facts, overview, a season picker for shows, then Request.
  var RQP = { el: null, r: null, d: null, busy: false, back: null };
  function rqpClose() {
    if (!RQP.el) return;
    RQP.el.remove(); RQP.el = null; RQP.r = RQP.d = null; RQP.busy = false;
    root.classList.remove('nj-modal-open');
    if (RQP.back && RQP.back.isConnected) RQP.back.focus();
  }
  function rqpOpen(r, from) {
    rqpClose();
    RQP.r = r; RQP.back = from || null;
    RQP.el = document.createElement('div');
    RQP.el.className = 'nj-sheet nj-rqp-wrap';
    document.body.appendChild(RQP.el);
    root.classList.add('nj-modal-open');
    rqpRender();
    var x = RQP.el.querySelector('.nj-rqp-x'); if (x) x.focus();
    rqFetch(r.mediaType + '/' + r.id).then(function (d) { if (RQP.r === r) { RQP.d = d; rqpRender(); } },
      function () { if (RQP.r === r) { RQP.d = { failed: true }; rqpRender(); } });
  }
  function rqpSeasons(d) {
    // state per season from the library and from earlier requests
    var st = {};
    each((d.mediaInfo && d.mediaInfo.seasons) || [], function (s) { st[s.seasonNumber] = s.status; });
    each((d.mediaInfo && d.mediaInfo.requests) || [], function (q) {
      if (q.status === 3) return; // declined
      each(q.seasons || [], function (s) { if (!st[s.seasonNumber] || st[s.seasonNumber] < 2) st[s.seasonNumber] = 2; });
    });
    return (d.seasons || []).filter(function (s) { return s.seasonNumber > 0; }).map(function (s) {
      return { n: s.seasonNumber, eps: s.episodeCount, st: st[s.seasonNumber] || 1 };
    });
  }
  function rqpRender() {
    if (!RQP.el) return;
    var r = RQP.r, d = RQP.d && !RQP.d.failed ? RQP.d : null, x = d || r;
    var title = x.title || x.name || '', year = (x.releaseDate || x.firstAirDate || '').slice(0, 4);
    var st = rqStatusOf(d || r), tv = r.mediaType === 'tv';
    var mins = d ? (tv ? (d.episodeRunTime && d.episodeRunTime[0]) : d.runtime) : 0;
    var facts = [year, tv ? (d && d.numberOfSeasons ? d.numberOfSeasons + (d.numberOfSeasons === 1 ? ' season' : ' seasons') : 'Show') : 'Movie',
      mins ? (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm') + (tv ? ' / episode' : '') : '',
      x.voteAverage ? '★ ' + (+x.voteAverage).toFixed(1) : ''].filter(Boolean);
    var genres = d && d.genres ? d.genres.slice(0, 3).map(function (g) { return g.name; }).join(', ') : '';
    var bd = x.backdropPath ? '<img alt="" src="https://image.tmdb.org/t/p/w780' + esc(x.backdropPath) + '">' : '';
    var poster = x.posterPath ? '<img alt="" src="https://image.tmdb.org/t/p/w342' + esc(x.posterPath) + '">' : '';
    var seasons = tv && d ? rqpSeasons(d) : [];
    var open = seasons.filter(function (s) { return rqCanRequest(s.st); });
    var anyIn = seasons.some(function (s) { return !rqCanRequest(s.st); });
    var picker = '';
    if (tv && d) {
      picker = '<fieldset class="nj-rqp-seasons"><legend>Seasons' + (open.length > 1 ? '<button type="button" class="nj-rq-link" data-nj-do="rqp-all">Select all</button>' : '') + '</legend><div class="nj-rqp-slist">' +
        seasons.map(function (s) {
          var can = rqCanRequest(s.st), on = can && (anyIn || (open[0] && s.n === open[0].n));
          var tag = s.st === 5 ? 'In library' : s.st === 4 ? 'Partly in library' : s.st === 2 || s.st === 3 ? 'Requested' : '';
          return '<label class="nj-rqp-s' + (can ? '' : ' nj-off') + '"><input type="checkbox" value="' + s.n + '"' + (can ? '' : ' disabled') + (on ? ' checked' : '') + '>' +
            '<span>Season ' + s.n + '</span><small>' + (s.eps ? s.eps + ' ep' : '') + (tag ? ' · ' + tag : '') + '</small></label>';
        }).join('') + '</div></fieldset>';
    }
    var can = tv ? (d ? open.length > 0 : rqCanRequest(st) || st === 4) : rqCanRequest(st);
    var note = !d && RQP.d && RQP.d.failed ? 'Could not load details.' :
      st === 5 ? 'Already in your library.' : (!tv && (st === 2 || st === 3)) ? 'Already requested.' : (tv && d && !open.length) ? 'Every season is in the library or requested.' : '';
    RQP.el.innerHTML = '<div class="nj-sheet-bd" data-nj-do="rqp-close"></div>' +
      '<div class="nj-rqp" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<div class="nj-rqp-bd">' + bd + '</div>' +
        '<button type="button" class="nj-rqp-x" data-nj-do="rqp-close" aria-label="Close"><svg class="nj-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
        '<div class="nj-rqp-body">' +
          '<div class="nj-rqp-head"><div class="nj-rqp-poster">' + poster + '</div><div class="nj-rqp-ti"><h2>' + esc(title) + '</h2>' +
            '<p class="nj-rqp-facts">' + facts.map(esc).join(' · ') + '</p>' + (genres ? '<p class="nj-rqp-gen">' + esc(genres) + '</p>' : '') + '</div></div>' +
          (x.overview ? '<p class="nj-rqp-ov">' + esc(x.overview) + '</p>' : (d ? '' : '<p class="nj-rqp-ov nj-rqp-wait">Loading details…</p>')) +
          picker +
          (can && RQ_ALT ? '<label class="nj-rq-alt"><input type="checkbox" class="nj-rq-alt-in"> ' + esc(RQ_ALT.label || 'Alternate profile') + '</label>' : '') +
          (note ? '<p class="nj-rqp-note">' + esc(note) + '</p>' : '') +
          '<div class="nj-rqp-act">' +
            (st === 5 && d && d.mediaInfo && d.mediaInfo.jellyfinMediaId ? '<a class="nj-rq-btn" href="' + esc(detailsHash(d.mediaInfo.jellyfinMediaId)) + '">Open in library</a>' : '') +
            (can ? '<button type="button" class="nj-rq-btn nj-rqp-go" data-nj-do="rqp-go"' + (tv && !d ? ' disabled' : '') + '>' + RQ_DL + '<span>Request</span></button>' : '') +
            '<button type="button" class="nj-rq-btn nj-rq-btn--ghost" data-nj-do="rqp-close">Close</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }
  function rqpGo(btn) {
    var r = RQP.r;
    if (!r || RQP.busy) return;
    var body = { mediaType: r.mediaType, mediaId: +r.id };
    if (r.mediaType === 'tv') {
      body.seasons = [];
      each(RQP.el.querySelectorAll('.nj-rqp-s input:checked:not(:disabled)'), function (c) { body.seasons.push(+c.value); });
      if (!body.seasons.length) { btn.querySelector('span').textContent = 'Pick a season'; return; }
    }
    var alt = RQP.el.querySelector('.nj-rq-alt-in');
    if (alt && alt.checked && RQ_ALT) body.profileId = +RQ_ALT.profileId; // requests.extraProfile: a second Radarr/Sonarr quality profile
    RQP.busy = true; btn.disabled = true; btn.querySelector('span').textContent = 'Requesting…';
    rqFetch('request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () {
        r.mediaInfo = Object.assign({}, r.mediaInfo || {}, { status: (r.mediaInfo && r.mediaInfo.status === 4) ? 4 : 2 });
        delete RQ.cache[RQ.q];
        if (RQ.list && RQ.res) RQ.res.innerHTML = '<h2 class="nj-rq-h">More titles</h2><div class="nj-rq-grid">' + RQ.list.map(rqCard).join('') + '</div>';
        btn.querySelector('span').textContent = 'Requested';
        setTimeout(rqpClose, 900);
      }, function () { RQP.busy = false; btn.disabled = false; btn.querySelector('span').textContent = 'Failed, try again'; });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && RQP.el) rqpClose(); });
  window.addEventListener('hashchange', rqpClose);

  /* ============ AUTO-UPDATE ============ */
  // autoUpdate.url returns { "v": "..." }, a value that changes with each release of the theme
  // files. Checked every autoUpdate.intervalMs and when the tab comes back. A new hash
  // reloads the page quietly, unless something is playing or being typed: then a small
  // "Update ready" toast waits, and the reload happens once playback stops.
  var UPD = { v: null, pending: false, el: null, timer: null };
  function updBusy() {
    if (playingNow()) return true;
    var media = document.querySelectorAll('audio, .videoPlayerContainer video');
    for (var i = 0; i < media.length; i++) if (!media[i].paused) return true;
    var f = document.activeElement;
    return !!(f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) && f.value);
  }
  function updReload() { location.reload(); }
  function updToast() {
    if (UPD.el) return;
    UPD.el = document.createElement('div');
    UPD.el.className = 'nj-upd';
    UPD.el.setAttribute('role', 'status');
    UPD.el.innerHTML = '<span>Update ready</span><button type="button" data-nj-do="upd-reload">Reload</button>';
    document.body.appendChild(UPD.el);
  }
  function updTry() {
    if (!UPD.pending) return;
    if (!updBusy()) return updReload();
    updToast();
    if (!UPD.timer) UPD.timer = setInterval(function () { if (!updBusy()) updReload(); }, 5000);
  }
  function updCheck() {
    if (document.hidden || !NJ.autoUpdate || !NJ.autoUpdate.url) return;
    fetch(NJ.autoUpdate.url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.v) return;
      if (UPD.v === null) UPD.v = d.v;
      else if (d.v !== UPD.v) { UPD.pending = true; updTry(); }
    }, function () {});
  }
  if (NJ.autoUpdate && NJ.autoUpdate.url) {
    updCheck();
    setInterval(updCheck, Math.max(10000, +NJ.autoUpdate.intervalMs || 60000));
    document.addEventListener('visibilitychange', updCheck);
    window.addEventListener('focus', updCheck);
  }

  /* ============ WATCHER ============ */
  // The pages sit below the top bar. Publish that offset once as a CSS variable, so a new detail
  // page can pull its backdrop up under the bar from its very first frame (no late jump).
  function syncPageTop() {
    var p = document.querySelector('.page:not(.hide)');
    if (!p) return;
    var top = Math.round(p.getBoundingClientRect().top + (window.scrollY || 0)) + 'px';
    if (root.style.getPropertyValue('--nj-page-top') !== top) root.style.setProperty('--nj-page-top', top);
  }
  function run() {
    disableCustomCssThemes();
    syncPageTop();
    ensureThemeButton();
    ensureTabBar();
    paintBadges();
    syncSearch();
    paintContinue();
    ensureOsdEpisodes();
    whoSync();
    tryPendingPlay();
    syncRequests();
    var detail = syncDetail();
    var sections = findHomeSections();
    var heroShown = false;
    if (NJ.hero.enabled) {
      if (!HERO.el || !HERO.el.isConnected) {
        HERO.el = null;
        if (sections) mountHero(sections);
      } else if (!visible(HERO.el)) {
        if (HERO.timer) stopCarousel();
        if (PV.slide) pvStop();
      } else {
        fitHero(); // no-op unless the page offset moved (e.g. the header changed height)
        if (!HERO.timer && HERO.items && !reduced.matches && HERO.items.length > 1) { restartCarousel(); pvArm(); }
      }
      heroShown = visible(HERO.el);
    }
    // My Media is off Home; CSS :has() does it, this covers browsers without :has()
    if (sections) each(sections.children, function (s) {
      if (!s.classList.contains('nj-gone') && s.querySelector('.card[data-type="UserView"], .card[data-type="CollectionFolder"]')) s.classList.add('nj-gone');
      // Live TV stays in the side menu only: its Home rows (Live TV shortcuts, On Now) are hidden
      if (!s.classList.contains('nj-gone') && (/^(Live TV|On Now)$/i.test(sectionTitle(s)) || s.querySelector('.card[data-type="Program"], .card[data-type="TvChannel"]'))) s.classList.add('nj-gone');
    });
    if (NJ.top10.enabled) { if (sections) syncTop10(sections); else if (TOP.state === 'idle') loadTop10(); }
    if (sections) syncXRows(sections);
    // header: scrim over a hero picture, solid once the page scrolls
    root.classList.toggle('nj-over-hero', heroShown || !!(detail && !detail.classList.contains('nj-no-bd')));
    root.classList.toggle('nj-solid', (window.scrollY || 0) > 24);
  }
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; run(); });
  }
  function start() {
    // head too: Jellyfin adds the Dashboard custom CSS <style> at runtime
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('hashchange', schedule);
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', function () { if (HERO.el) fitHero(); schedule(); });
    run();
  }
  disableCustomCssThemes();
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
