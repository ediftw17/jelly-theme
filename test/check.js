/* Smoke check for dist/jelly.css + dist/jelly.js with the default config.

   Needs playwright-core and a helper `lib.js` next to this file that exports
   open({ css, js }) -> { b, ctx, page }: it launches Chromium, serves the two given
   files in place of the theme files your server injects, signs in to your Jellyfin
   server and returns on Home. Keep server address and credentials inside that helper
   (read from your own secret store); never commit them.

   Run:   node check.js                (phone, 390x844)
          DESKTOP=1 node check.js      (desktop, 1440x900)
   JELLY_DIST points at the folder with jelly.css and jelly.js (default: ../dist).

   Fails (exit 1) on any page error, a missing html[data-nj-theme], no cards on
   Home, no tab bar on the phone, or any request to an optional extra that is off
   by default (trailers, top10 file, avatars, Seerr proxy, downloads, version file). */
const path = require('path');
const { open } = require('./lib');

const dist = process.env.JELLY_DIST || path.resolve(__dirname, '../dist');
const css = path.join(dist, 'jelly.css');
const js = path.join(dist, 'jelly.js');
const desktop = !!process.env.DESKTOP;
const FORBIDDEN = /\/nj-trailers\/|\/nj\/top10\.json|\/nj\/avatars\/|\/nj-req\/|\/nj-dl\/|\/nj\/version\.json/i;

(async () => {
  const fails = [];
  const errors = [];
  const hits = new Set();
  const { b, page } = await open({ css, js });
  try {
    // the first load happened inside open(): read what it fetched from the page itself
    const first = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
    first.filter((u) => FORBIDDEN.test(u)).forEach((u) => hits.add(u));

    // reload with listeners attached, then walk Home, a title page and Search
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    page.on('request', (r) => { if (FORBIDDEN.test(r.url())) hits.add(r.url()); });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const home = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-nj-theme'),
      cards: document.querySelectorAll('.card').length,
      tabs: !!document.querySelector('nav.nj-tabs'),
      hero: !!document.querySelector('.nj-hero'),
      top10: document.querySelectorAll('.nj-top10 .nj-t10').length,
      picker: !!document.querySelector('.nj-who')
    }));
    if (!home.theme) fails.push('html has no data-nj-theme');
    if (!home.cards) fails.push('Home rendered no cards');
    if (!desktop && !home.tabs) fails.push('no phone tab bar');
    if (home.picker) fails.push('profile picker opened with no profiles configured');

    // a title page (detail backdrop, trailer lookup path)
    const card = await page.$('.card[data-type="Movie"] a, .card[data-type="Series"] a, .card[data-type="Movie"] button, .card[data-type="Series"] button');
    if (card) {
      await card.click().catch(() => {});
      await page.waitForTimeout(4000);
    }
    // Search with a query (Seerr requests path)
    await page.evaluate(() => { location.hash = '#/search'; });
    await page.waitForTimeout(2500);
    const box = await page.$('#searchTextInput');
    if (box) { await box.fill('the'); await page.waitForTimeout(3000); }

    if (errors.length) fails.push('page errors: ' + errors.join(' | '));
    if (hits.size) fails.push('requests to optional extras: ' + [...hits].join(', '));

    console.log(JSON.stringify({ context: desktop ? 'desktop 1440x900' : 'phone 390x844', home, pageErrors: errors.length, forbiddenRequests: hits.size }));
    console.log(fails.length ? 'FAIL\n- ' + fails.join('\n- ') : 'PASS');
  } finally {
    await b.close();
  }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e && e.message || e); process.exit(1); });
