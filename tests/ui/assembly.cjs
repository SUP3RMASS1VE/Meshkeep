/* Run against tests/ui/fixture_server.py; no personal library is used. */
const {chromium} = require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const base = process.env.MME_TEST_URL || 'http://127.0.0.1:18759';
  const headers = {'X-Auth': 'qa', 'Content-Type': 'application/json'};
  const request = async (endpoint, body) => {
    const response = await fetch(base + endpoint, body === undefined
      ? {headers} : {method: 'POST', headers, body: JSON.stringify(body)});
    const result = await response.json();
    assert.ok(response.ok, result.error || `${endpoint}: HTTP ${response.status}`);
    return result;
  };
  const {root} = await request('/api/config');
  assert.match(path.basename(path.dirname(root)), /^mme-ui-/, 'Use the disposable UI fixture server.');
  const testName = 'Assembly studio UI test';
  for (const item of (await request('/api/workspace')).projects.filter(p => p.name === testName)) {
    await request('/api/project', {action: 'delete', id: item.id});
  }
  const missingPath = path.join(root, 'Assembly missing fixture.stl');
  fs.copyFileSync(path.join(root, 'Workshop cube.stl'), missingPath);
  let project = await request('/api/project', {
    root, name: testName,
    paths: [path.join(root, 'Workshop cube.stl'), path.join(root, 'Two-part assembly.3mf'), missingPath]
  });
  const first = project.parts[0], other = project.parts[1];
  project = await request('/api/project', {
    action: 'part', id: project.id, part_id: first.id, name: first.name,
    required: 3, completed: 1, status: 'printing', notes: 'Two copies remain.'
  });
  fs.unlinkSync(missingPath);
  const readProject = () => request('/api/project?id=' + project.id);
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.MME_CHROME_PATH || undefined,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const screenshotDir = process.env.MME_SCREENSHOT_DIR || os.tmpdir();
  const waitForReady = async () => {
    await page.waitForFunction(() => document.querySelectorAll('#assemblyParts option').length === 4
      && !document.getElementById('assemblyApply').disabled);
  };
  const open = async () => {
    await page.locator('#projectAssembly').click();
    await waitForReady();
  };
  const setPlacement = async (position, rotation = [0, 0, 0]) => {
    for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
      await page.locator('#assemblyPosition' + axis).fill(String(position[i]));
      await page.locator('#assemblyRotation' + axis).fill(String(rotation[i]));
    }
    await page.locator('#assemblyApply').click();
  };
  const save = async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/project')
      && response.request().method() === 'POST'
      && response.request().postDataJSON().action === 'layout');
    await page.locator('#assemblySave').click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.getElementById('assemblyApply').disabled);
  };
  try {
    await page.goto(base + '/?t=qa');
    await page.locator('#projectList button').filter({hasText: testName}).click();
    await open();
    assert.equal(await page.locator('#assemblyParts option[data-printed="true"]').count(), 1);
    assert.equal(await page.locator('#assemblyParts option[data-printed="false"]').count(), 3);
    assert.match(await page.locator('#assemblyWarnings').textContent(), /Assembly missing fixture/);
    // Pick a piece through the canvas, without reaching into the viewer's state.
    // The fixture fits near the centre; sample a small grid of screen positions.
    await page.locator('#assemblyParts').selectOption(`${other.id}:0`);
    const canvas = await page.locator('#assemblyCanvas canvas').boundingBox();
    let picked = false;
    for (const y of [.4, .5, .6, .35, .45, .55, .65]) {
      for (const x of [.4, .5, .6, .35, .45, .55, .65]) {
        await page.mouse.click(canvas.x + canvas.width * x, canvas.y + canvas.height * y);
        if (await page.locator('#assemblyParts').inputValue() !== `${other.id}:0`) { picked = true; break; }
      }
      if (picked) break;
    }
    assert.ok(picked, 'Clicking a visible model selects its project copy.');
    // Locate the red move handle in the rendered image and drag it as a user
    // would. This verifies the real gizmo/orbit interaction, without test hooks.
    await page.locator('#assemblyParts').selectOption(`${first.id}:0`);
    const beforeDrag = await page.locator('#assemblyPositionX').inputValue();
    const handleImage = await page.locator('#assemblyCanvas canvas').screenshot();
    const redHandle = await page.evaluate(async base64 => {
      const blob = await (await fetch('data:image/png;base64,' + base64)).blob();
      const image = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let x = 0, y = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110) {
          const pixel = i / 4; x += pixel % canvas.width; y += Math.floor(pixel / canvas.width); count++;
        }
      }
      image.close();
      return count ? {x: x / count / canvas.width, y: y / count / canvas.height} : null;
    }, handleImage.toString('base64'));
    assert.ok(redHandle, 'Selected piece has a visible red move handle.');
    const handleX = canvas.x + canvas.width * redHandle.x;
    const handleY = canvas.y + canvas.height * redHandle.y;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX + 50, handleY + 20, {steps: 8});
    await page.mouse.up();
    assert.notEqual(await page.locator('#assemblyPositionX').inputValue(), beforeDrag, 'Dragging the red handle moves the selected copy.');
    await page.locator('#assemblyParts').selectOption(`${first.id}:1`);
    assert.match(await page.locator('#assemblySelectionPath').textContent(), /Workshop cube\.stl/);
    assert.match(await page.locator('#assemblySelectionProgress').textContent(), /1.*3/);
    await setPlacement([31.25, -12.5, 20], [15, 0, 90]);
    await save();
    const saved = await readProject();
    const placement = saved.layout.find(p => p.part_id === first.id && p.copy_index === 1);
    assert.deepEqual(placement.position, [31.25, -12.5, 20]);
    placement.rotation.forEach((angle, index) => assert.ok(Math.abs(angle - [15, 0, 90][index]) < 1e-9));
    assert.equal(saved.layout.length, 4, 'Every rendered copy has an independent placement.');
    console.log('PASS mixed formats, copy progress, canvas picking, gizmo drag, missing file and saved transforms');

    await page.locator('#assemblyFocus').click();
    assert.match(await page.locator('#assemblySceneCount').textContent(),/Focused piece/);
    await page.locator('#assemblyGhosts').uncheck();
    assert.deepEqual((await readProject()).layout,saved.layout,'View controls must not alter placements.');
    await page.locator('#assemblyFit').click();
    assert.match(await page.locator('#assemblySceneCount').textContent(),/4 of 5/);
    await page.locator('#assemblyGhosts').check();

    await page.locator('#assemblyExplode').fill('100');
    await page.locator('#assemblyExplode').dispatchEvent('input');
    assert.equal(await page.locator('#assemblyApply').isDisabled(), true);
    assert.deepEqual((await readProject()).layout, saved.layout, 'Exploded view must not rewrite assembly positions.');
    await page.screenshot({path: path.join(screenshotDir, 'meshkeep-assembly-exploded.png')});
    await page.locator('#assemblyExplode').fill('0');
    await page.locator('#assemblyExplode').dispatchEvent('input');
    assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()), 31.25);
    await page.locator('#assemblyClose').click();
    await page.locator('#assemblyDialog').waitFor({state: 'hidden'});
    await open();
    await page.locator('#assemblyParts').selectOption(`${first.id}:1`);
    assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()), 31.25);
    assert.equal(Number(await page.locator('#assemblyPositionY').inputValue()), -12.5);
    assert.equal(Number(await page.locator('#assemblyRotationZ').inputValue()), 90);
    console.log('PASS explosion keeps base transforms and reopen restores layout');

    page.once('dialog',dialog=>dialog.dismiss());
    await page.locator('#assemblyCompact').click();
    assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()),31.25);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#assemblyCompact').click();
    assert.equal(Number(await page.locator('#assemblyRotationZ').inputValue()),90,'Compact layout retains rotations.');
    assert.deepEqual((await readProject()).layout,saved.layout,'Compacting requires an explicit save.');
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#assemblyClose').click();await open();
    await page.locator('#assemblyParts').selectOption(`${first.id}:1`);
    assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()),31.25);
    console.log('PASS compact layout confirmation and unsaved preservation; focus and visibility');

    await setPlacement([40, -12.5, 20], [15, 0, 90]);
    let failNextSave = true;
    await page.route('**/api/project', async route => {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'layout' && failNextSave) {
        failNextSave = false;
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Simulated save failure'})});
      } else await route.continue();
    });
    await page.locator('#assemblySave').click();
    await page.waitForFunction(() => document.getElementById('assemblyDialog').textContent.includes('Simulated save failure'));
    assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()), 40);
    assert.deepEqual((await readProject()).layout, saved.layout);
    await save();
    await page.unroute('**/api/project');
    assert.equal((await readProject()).layout.find(p => p.part_id === first.id && p.copy_index === 1).position[0], 40);
    console.log('PASS save failure retains edits and retry succeeds');

    await page.locator('#assemblyParts').selectOption(`${other.id}:0`);
    await setPlacement([0, 0, 50]);
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#assemblyClose').click();
    assert.equal(await page.locator('#assemblyDialog').isVisible(), true);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#assemblyClose').click();
    await page.locator('#assemblyDialog').waitFor({state: 'hidden'});
    await open();
    await page.locator('#assemblyParts').selectOption(`${other.id}:0`);
    assert.notEqual(Number(await page.locator('#assemblyPositionZ').inputValue()), 50, 'Discarded position is not persisted.');
    console.log('PASS unsaved close can be cancelled or discarded');

    await page.setViewportSize({width: 480, height: 850});
    await page.screenshot({path: path.join(screenshotDir, 'meshkeep-assembly-mobile.png')});
    assert.ok((await page.locator('#assemblyDialog').boundingBox()).width <= 480);
    assert.ok(await page.locator('#assemblyDialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'No horizontal overflow.');
    await page.locator('#assemblyClose').click();
    await page.setViewportSize({width: 1440, height: 1000});

    // Delay a genuine load, close while it is in flight, then start a fresh generation.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let started;
    const loadingStarted = new Promise(resolve => { started = resolve; });
    let heldOnce = false;
    await page.route('**/api/model?**', async route => {
      if (!heldOnce) {
        heldOnce = true; started(); await held;
      }
      await route.continue().catch(() => {});
    });
    await page.locator('#projectAssembly').click();
    await loadingStarted;
    await page.locator('#assemblyClose').click();
    await page.locator('#assemblyDialog').waitFor({state: 'hidden'});
    release();
    await open();
    await page.unroute('**/api/model?**');
    assert.equal(await page.locator('#assemblyParts option').count(), 4);
    await page.locator('#assemblyFit').click();
    await page.screenshot({path: path.join(screenshotDir, 'meshkeep-assembly.png')});
    assert.deepEqual(errors, []);
    console.log('PASS responsive layout and close/reopen during loading');
    console.log('ASSEMBLY_UI_PASS');
  } catch (error) {
    await page.screenshot({path: path.join(screenshotDir, 'meshkeep-assembly-failure.png')}).catch(() => {});
    console.error('Assembly UI state:', await page.locator('#assemblyDialog').textContent().catch(() => 'dialog unavailable'));
    throw error;
  } finally {
    await browser.close();
    await request('/api/project', {action: 'delete', id: project.id});
    if (fs.existsSync(missingPath)) fs.unlinkSync(missingPath);
  }
})().catch(error => { console.error(error); process.exit(1); });
