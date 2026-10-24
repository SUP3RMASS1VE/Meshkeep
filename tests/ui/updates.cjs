// Render the actual update UI with a simulated desktop bridge. No real updates.
const {chromium} = require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.MME_CHROME_PATH || undefined});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 860}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://meshkeep.test/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (['app.js', 'workspace.js', 'browser.js'].includes(name)) return route.fulfill({body: '', contentType: 'application/javascript'});
      if (name === 'meshkeep-icon.png') return route.fulfill({body: await fs.readFile(path.join(__dirname, '../../web/meshkeep-icon.png')), contentType: 'image/png'});
      if (!['index.html', 'style.css', 'updates.js'].includes(name)) return route.fulfill({status: 204});
      await route.fulfill({body: await fs.readFile(path.join(__dirname, '../../web', name)), contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
    });
    await page.addInitScript(() => {
      let listener;
      let state = {status: 'idle', currentVersion: '2.0.4', version: null, canInstall: true, percent: 0, revision: 0};
      window.updateTest = patch => { state = {...state, revision: state.revision + 1, ...patch}; listener(state); };
      window.meshkeepDesktop = {
        updateStatus: async () => state,
        checkUpdate: async () => { window.updateTest({status: 'available', version: '2.0.5'}); return state; },
        downloadUpdate: async () => { window.updateTest({status: 'downloading', percent: 37}); return state; },
        installUpdate: async () => { window.updateTest({status: 'installing'}); return state; },
        onUpdateState: cb => { listener = cb; return () => {}; }, onShowUpdates: () => () => {}, updateRelease: async () => {},
      };
    });
    await page.goto('http://meshkeep.test/');
    assert.equal(await page.locator('#updateBanner').isVisible(), false);
    await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
    await page.getByRole('button', {name: 'Download update', exact: true}).waitFor();
    const dir = process.env.MME_SCREENSHOT_DIR || require('node:os').tmpdir();
    await page.screenshot({path: path.join(dir, 'meshkeep-update-available.png')});
    await page.getByRole('button', {name: 'Download update', exact: true}).click();
    assert.equal(await page.locator('#updateProgress').getAttribute('aria-label'), 'Update download progress');
    assert.match(await page.locator('#updateMessage').textContent(), /37%/);
    await page.getByRole('button', {name: 'Dismiss update notice'}).click();
    assert.equal(await page.locator('#updateBanner').isVisible(), false);
    await page.evaluate(() => window.updateTest({status: 'downloaded', percent: 100}));
    await page.getByRole('button', {name: 'Restart and install', exact: true}).waitFor();
    await page.screenshot({path: path.join(dir, 'meshkeep-update-ready.png')});
    await page.evaluate(() => window.updateTest({status: 'available', canInstall: false}));
    assert.equal(await page.getByRole('button', {name: 'Download update', exact: true}).count(), 0);
    await page.getByRole('button', {name: 'View release', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Check for updates', exact: true}).click();
    await page.evaluate(() => window.updateTest({status: 'unavailable', message: 'The published GitHub release does not include automatic update files yet. You can keep using Meshkeep and check again after the next release.'}));
    await page.getByRole('button', {name: 'Check again', exact: true}).waitFor();
    assert.equal(await page.locator('#updateTitle').textContent(), 'Automatic updates are not available yet');
    assert.doesNotMatch(await page.locator('#updateMessage').textContent(), /internet|connection/i);
    await page.screenshot({path: path.join(dir, 'meshkeep-update-not-published.png')});
    assert.deepEqual(errors, []);
    console.log('UPDATE_UI_PASS: availability, progress, defer, restart, unsigned Mac');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
