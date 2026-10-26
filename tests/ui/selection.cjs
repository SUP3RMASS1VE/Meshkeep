/* Selection and project integration against the disposable fixture server. */
const {chromium}=require(process.env.MME_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const base='http://127.0.0.1:18759',headers={'X-Auth':'qa','Content-Type':'application/json'};
 const api=async(route,body)=>{const response=await fetch(base+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,data.error);return data};
 const {root}=await api('/api/config');assert.match(path.basename(path.dirname(root)),/^mme-ui-/);
 const folder=path.join(root,'Selection fixtures');
 const project=await api('/api/project',{name:'Select All project test',root,paths:[]});
 const browser=await chromium.launch({headless:true,executablePath:process.env.MME_CHROME_PATH||undefined});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 const selected=async n=>{await page.waitForFunction(n=>document.getElementById('selectionCount').textContent===`${n} selected for batch edit`,n)};
 const clear=async()=>{await page.locator('#clearSelection').click();await selected(0)};
 try{
  await page.goto(base+'/?t=qa');await page.locator('#selectAllModels:enabled').waitFor();
  await page.locator('#selectAllModels').click();await selected(7);
  assert.equal(await page.locator('.filerow input:checked').count(),7);
  await page.locator('#projectList button').filter({hasText:project.name}).click();
  await page.locator('#projectAddSelected').click();await page.waitForFunction(()=>document.querySelectorAll('.project-part').length===7);
  assert.equal((await api('/api/project?id='+project.id)).parts.length,7);
  await page.locator('[data-close=projectDialog]').click();await clear();
  for(const shortcut of ['Meta+a','Control+a']){
   await page.locator('#viewModes [data-view=grid]').focus();await page.keyboard.press(shortcut);await selected(7);await clear();
  }
  await page.locator('#searchInput').fill('Workshop');await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='1 model');
  await page.keyboard.press('Meta+a');
  assert.deepEqual(await page.locator('#searchInput').evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,8]);
  await selected(0);
  await page.locator('#selectAllModels').click();await selected(1);
  await page.locator('#projectList button').filter({hasText:project.name}).click();
  await page.locator('#projectTitle').click();await page.keyboard.press('Control+a');await selected(1);
  await page.locator('[data-close=projectDialog]').click();await clear();
  await page.locator('#searchInput').fill('');await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='7 models');
  fs.mkdirSync(folder,{recursive:true});for(let i=0;i<121;i++)fs.copyFileSync(path.join(root,'Workshop cube.stl'),path.join(folder,`Selection ${i}.stl`));
  await page.locator('#indexFolder').click();await page.waitForFunction(()=>!document.getElementById('indexFolder').disabled);
  await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='211 models');
  await page.locator('#selectAllModels').click();await selected(211);
  assert.equal(await page.locator('.filerow input:checked').count(),80);
  await page.locator('#nextPage').click();await page.waitForFunction(()=>document.getElementById('pageStatus').textContent==='81–160 of 211');
  assert.equal(await page.locator('.filerow input:checked').count(),80);
  await clear();
  await page.locator('#searchInput').fill('Workshop');await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='1 model');
  let release,started;const held=new Promise(resolve=>release=resolve),requested=new Promise(resolve=>started=resolve);
  await page.route('**/api/browse?**',async route=>{if(new URL(route.request().url()).searchParams.get('limit')==='200'){started();await held}await route.continue()});
  await page.locator('#selectAllModels').click();await requested;
  await page.locator('#searchInput').fill('Display');await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='3 models');release();
  await page.locator('#selectAllModels:enabled').waitFor();await page.waitForTimeout(200);await selected(0);
  await page.unroute('**/api/browse?**');
  await page.locator('#selectAllModels').click();await selected(3);await clear();
  await page.route('**/api/browse?**',async route=>{if(new URL(route.request().url()).searchParams.get('limit')==='200')await route.fulfill({contentType:'application/json',body:JSON.stringify({total:501,files:[]})});else await route.continue()});
  await page.locator('#selectAllModels').click();await page.waitForFunction(()=>document.getElementById('toastMsg').textContent.includes('up to 500'));await selected(0);
  await page.unroute('**/api/browse?**');
  assert.deepEqual(errors,[]);console.log('SELECTION_UI_PASS: button, both shortcuts, typing/modal protection, project addition, 211 results across pages, cancellation and limit feedback');
 }finally{await browser.close();await api('/api/project',{action:'delete',id:project.id});fs.rmSync(folder,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
