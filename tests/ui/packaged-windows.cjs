/* Exercise the actual installed executable, using synthetic files and a separate catalogue. */
const { _electron: electron } = require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

(async () => {
 const executable = process.env.MME_INSTALLED_APP;
 assert.ok(executable, 'Set MME_INSTALLED_APP to the installed Meshkeep.exe');
 const folder = path.resolve('build/installed-app-qa');
 fs.mkdirSync(folder, {recursive:true});
 const model = path.join(folder, 'Painted cube ü & test.3mf');
 assert.ok(fs.existsSync(model), 'Generate the synthetic painted cube first');
 const before = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
 let application;
 const launch = async () => {
  application = await electron.launch({executablePath:executable, args:['--user-data-dir='+path.join(folder,'profile'), '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env:{...process.env, LOCALAPPDATA:folder}, timeout:30000});
  const page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#pathInput').fill(folder);
  await page.locator('#pathInput').press('Enter');
  await page.locator('.model-card').filter({hasText:path.basename(model)}).click();
  await page.waitForFunction(()=>!document.getElementById('single').hidden);
  return page;
 };
 try {
  let page = await launch();
  assert.equal(await application.evaluate(({app})=>app.isPackaged), true);
  assert.equal(await application.evaluate(({app})=>app.getVersion()), JSON.parse(fs.readFileSync(path.resolve('desktop/package.json'),'utf8')).version);
  const url = page.url();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('#modelTags').fill('windows-installer-qa');
  await page.locator('#modelNotes').fill('Persistent organisation verified');
  await page.locator('#modelStatus').selectOption('want');
  await page.locator('#saveOrganization').click();
  await page.waitForFunction(()=>!document.getElementById('saveOrganization').disabled);
  await page.locator('#openStudio').click();
  await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.includes('triangles'));
  const colours = await page.evaluate(async model => {
   const THREE = await import('three');
   const {loadModel,dispose} = await import('/studio.js');
   const loaded=await loadModel(model);const colours=new Set();
   loaded.object.traverse(mesh=>{if(mesh.isMesh && mesh.geometry.attributes.color){const c=mesh.geometry.attributes.color;for(let i=0;i<c.count;i++)colours.add(new THREE.Color().fromBufferAttribute(c,i).getHexString());}});
   dispose(loaded.object);return [...colours].sort();
  }, model);
  assert.deepEqual(colours, ['00ff00','676868','fafbff']);
  await page.screenshot({path:path.resolve('build/installed-app-painted-colours.png')});
  assert.deepEqual(errors, []);
  const second=spawn(executable, ['--user-data-dir='+path.join(folder,'profile')], {windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{second.kill();reject(Error('Second instance did not exit'))},10000);second.on('error',reject);second.on('exit',()=>{clearTimeout(timer);resolve()})});
  assert.equal(application.windows().length,1);
  await application.close();application=null;
  await assert.rejects(()=>fetch(url,{signal:AbortSignal.timeout(2000)}));
  page=await launch();
  assert.equal(await page.locator('#modelNotes').inputValue(), 'Persistent organisation verified');
  assert.equal(await page.locator('#modelStatus').inputValue(), 'want');
  assert.match(await page.locator('#modelTags').inputValue(), /windows-installer-qa/);
  await application.close();application=null;
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex'),before);
  console.log('INSTALLED_APP_PASS: bundled runtime, model loading, painted colours, persistent organisation, single instance, server shutdown, original model unchanged');
 } finally { if(application)await application.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
