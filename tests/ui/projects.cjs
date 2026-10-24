const {chromium}=require(process.env.MME_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MME_CHROME_PATH||undefined});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const base='http://127.0.0.1:18759';
  const data=await(await fetch(base+'/api/workspace?t=qa')).json();
  for(const project of data.projects.filter(p=>p.name==='Robot UI test'))await fetch(base+'/api/project',{method:'POST',headers:{'X-Auth':'qa','Content-Type':'application/json'},body:JSON.stringify({action:'delete',id:project.id})});
  await page.goto(base+'/?t=qa');
  await page.locator('.model-card').first().waitFor();
  await page.locator('#searchInput').fill('Workshop cube');
  await page.waitForFunction(()=>document.getElementById('resultsStatus').textContent==='1 model');
  await page.locator('.filerow input[type=checkbox]').check();
  await page.locator('#newProject').click();await page.locator('#newProjectName').fill('Robot UI test');
  await page.locator('#projectCreateForm button[type=submit]').click();
  await page.locator('.project-part').waitFor();
  const part=page.locator('.project-part');
  await part.locator('[name=required]').fill('3');await part.locator('[name=completed]').fill('1');await part.locator('[name=status]').selectOption('printing');
  await part.locator('[name=notes]').fill('Two copies still needed');await part.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('projectSummary').textContent.startsWith('1 of 3'));
  await page.locator('#projectAddSelected').click();await page.waitForTimeout(200);assert.equal(await page.locator('.project-part').count(),1);
  await page.locator('[data-close=projectDialog]').click();await page.reload();
  await page.locator('#projectList button').filter({hasText:'Robot UI test'}).click();
  assert.equal(await part.locator('[name=notes]').inputValue(),'Two copies still needed');
  await part.locator('[name=status]').selectOption('assembled');await part.locator('button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('projectSummary').textContent==='3 of 3 copies printed · 1 of 1 parts assembled');
  await page.screenshot({path:'/tmp/meshkeep-projects.png'});
  await page.setViewportSize({width:480,height:850});assert.ok((await page.locator('#projectDialog').boundingBox()).width<=480);
  page.on('dialog',dialog=>dialog.accept());await part.getByRole('button',{name:'Remove part'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.project-part').length===0);
  await page.locator('#projectDelete').click();await page.locator('#projectDialog').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log('PROJECTS_UI_PASS');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
