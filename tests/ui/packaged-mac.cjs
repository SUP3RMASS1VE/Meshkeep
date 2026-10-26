/* Verify the actual Mac bundle using generated models and an isolated HOME/profile. */
const {_electron: electron} = require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
(async () => {
 assert.equal(process.platform, 'darwin', 'Run this check on macOS');
 const executable = process.env.MME_INSTALLED_APP;
 assert.ok(executable, 'Set MME_INSTALLED_APP to Meshkeep.app/Contents/MacOS/Meshkeep');
 const source = path.resolve('build/installed-app-qa/Painted cube ü & test.3mf');
 assert.ok(fs.existsSync(source), 'Run python3 tests/ui/make_packaged_fixture.py first');
 const folder = fs.mkdtempSync(path.resolve('build/mac-package-qa-'));
 const home = path.join(folder, 'home'), models = path.join(home, 'Models');
 fs.mkdirSync(models, {recursive:true});
 const model = path.join(models, path.basename(source)); fs.copyFileSync(source, model);
 const before = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
 const profile = path.join(folder, 'profile');
 let application;
 const launch = async () => {
  application = await electron.launch({executablePath: executable,
   args:['--user-data-dir='+profile,'--use-angle=swiftshader','--enable-unsafe-swiftshader'],
   env:{...process.env, HOME:home, CFFIXED_USER_HOME:home}, timeout:30000});
  const userData = await application.evaluate(({app})=>app.getPath('userData'));
  assert.ok(userData.startsWith(folder+path.sep), 'Keep Electron preferences inside the test folder: '+userData);
  const page = await application.firstWindow(); page.setDefaultTimeout(30000);
  await page.waitForLoadState('domcontentloaded');
  const configuration = await page.evaluate(async()=>{
   const token=new URLSearchParams(location.search).get('t');
   return (await fetch('/api/config',{headers:{'X-Auth':token}})).json();
  });
  assert.equal(configuration.root, home, 'Packaged server must use the isolated test HOME');
  await page.locator('#pathInput').fill(models); await page.locator('#pathInput').press('Enter');
  await page.locator('.model-card').filter({hasText:path.basename(model)}).click();
  await page.waitForFunction(()=>!document.getElementById('single').hidden);
  if(await page.locator('#studioDialog').evaluate(dialog=>dialog.open)) await page.locator('#studioDialog form button').click();
  return page;
 };
 try {
  let page=await launch();
  assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
  assert.equal(await application.evaluate(({app})=>app.getVersion()),JSON.parse(fs.readFileSync(path.resolve('desktop/package.json'),'utf8')).version);
  const url=page.url();
  for(const shortcut of ['Meta+a','Control+a']){
   await page.locator('#viewModes [data-view=grid]').focus();
   await page.keyboard.press(shortcut);
   await page.waitForFunction(()=>document.getElementById('selectionCount').textContent==='1 selected for batch edit');
   assert.equal(await page.locator('.filerow input:checked').count(),1);
   await page.locator('#clearSelection').click();
  }
  await page.locator('#pathInput').focus();
  await page.keyboard.press('Meta+a');
  assert.equal(await page.locator('#pathInput').evaluate(el=>el.selectionEnd-el.selectionStart),models.length);
  assert.equal(await page.locator('.filerow input:checked').count(),0);
  await page.locator('.filerow input[type=checkbox]').check();
  await page.locator('#newProject').click();
  await page.locator('#newProjectName').fill('Packaged multipart build');
  await page.locator('#projectCreateForm button[type=submit]').click();
  const part=page.locator('.project-part');
  await part.locator('[name=required]').fill('3');
  await part.locator('[name=completed]').fill('2');
  await part.locator('[name=status]').selectOption('printing');
  await part.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('projectSummary').textContent.startsWith('2 of 3'));
  await page.locator('#projectAssembly').click();
  await page.waitForFunction(()=>document.querySelectorAll('#assemblyParts option').length===3&&!document.getElementById('assemblyApply').disabled);
  assert.equal(await page.locator('#assemblyParts option[data-printed="true"]').count(),2);
  await page.locator('#assemblyPositionX').fill('12.5');
  await page.locator('#assemblyRotationZ').fill('45');
  await page.locator('#assemblyApply').click();
  const savedLayout=page.waitForResponse(response=>response.url().endsWith('/api/project')&&response.request().method()==='POST'&&response.request().postDataJSON().action==='layout');
  await page.locator('#assemblySave').click();
  assert.equal((await savedLayout).status(),200);
  await page.waitForFunction(()=>!document.getElementById('assemblyApply').disabled);
  await page.locator('#assemblyClose').click();
  await page.locator('[data-close=projectDialog]').click();
  await page.locator('#modelTags').fill('shared-source-qa');
  await page.locator('#modelNotes').fill('Mac and Windows shared source');
  await page.locator('#modelStatus').selectOption('want');
  await page.locator('#saveOrganization').click();
  await page.waitForFunction(()=>!document.getElementById('saveOrganization').disabled);
  await page.locator('#openStudio').click();
  await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.includes('triangles'));
  const colours=await page.evaluate(async model=>{
   const THREE=await import('three'),{loadModel,dispose}=await import('/studio.js');
   const loaded=await loadModel(model),colours=new Set();
   loaded.object.traverse(mesh=>{const c=mesh.geometry?.attributes.color;if(c)for(let i=0;i<c.count;i++)colours.add(new THREE.Color().fromBufferAttribute(c,i).getHexString());});
   dispose(loaded.object);return [...colours].sort();
  },model);
  assert.deepEqual(colours,['00ff00','676868','fafbff']);
  await page.screenshot({path:path.resolve('build/mac-shared-painted-colours.png')});
  const second=spawn(executable,['--user-data-dir='+profile],{env:{...process.env,HOME:home,CFFIXED_USER_HOME:home},stdio:'ignore'});
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{second.kill();reject(Error('Second instance did not exit'));},10000);
   second.on('error',error=>{clearTimeout(timer);reject(error)});
   second.on('exit',code=>{clearTimeout(timer);assert.equal(code,0);resolve()});
  });
  assert.equal(application.windows().length,1);
  await application.close();application=null;
  await assert.rejects(()=>fetch(url,{signal:AbortSignal.timeout(2000)}));
  page=await launch();
  assert.equal(await page.locator('#modelNotes').inputValue(),'Mac and Windows shared source');
  assert.equal(await page.locator('#modelStatus').inputValue(),'want');
  assert.match(await page.locator('#modelTags').inputValue(),/shared-source-qa/);
  await page.locator('#projectList button').filter({hasText:'Packaged multipart build'}).click();
  await page.waitForFunction(()=>document.getElementById('projectSummary').textContent.startsWith('2 of 3'));
  assert.equal(await page.locator('.project-part [name=status]').inputValue(),'printing');
  await page.locator('.project-part [name=status]').selectOption('assembled');
  await page.locator('.project-part button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('projectSummary').textContent==='3 of 3 copies printed · 1 of 1 parts assembled');
  await page.locator('#projectAssembly').click();
  await page.waitForFunction(()=>document.querySelectorAll('#assemblyParts option').length===3&&!document.getElementById('assemblyApply').disabled);
  assert.equal(await page.locator('#assemblyParts option[data-printed="true"]').count(),3);
  assert.equal(Number(await page.locator('#assemblyPositionX').inputValue()),12.5);
  assert.equal(Number(await page.locator('#assemblyRotationZ').inputValue()),45);
  await page.screenshot({path:path.resolve('build/mac-assembly-studio.png')});
  await page.locator('#assemblyClose').click();
  await page.screenshot({path:path.resolve('build/mac-multipart-project.png')});
  await application.close();application=null;
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex'),before);
  console.log('MAC_PACKAGED_PASS: bundled runtime, Select All keyboard shortcuts and text selection, isolated catalogue, painted colours, saved organisation, multipart projects, Assembly Studio layout persistence and progress, restart, single instance, server shutdown, model unchanged');
 } finally {if(application)await application.close()}
})().catch(error=>{console.error(error);process.exit(1)});
