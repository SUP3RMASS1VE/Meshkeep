/* Opt-in large-model checks. Serve this project with a temporary catalogue and
   set MME_LARGE_CASES to a JSON array of {path, triangles?}. Originals are read only. */
const {chromium}=require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const cases=JSON.parse(fs.readFileSync(process.env.MME_LARGE_CASES,'utf8'));
 for(let index=0;index<cases.length;index++) {
  const item=cases[index], before=fs.statSync(item.path);
  const browser=await chromium.launch({headless:true,executablePath:process.env.MME_CHROME_PATH || undefined,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
   const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(180000);
   const errors=[];page.on('pageerror',e=>errors.push(String(e)));
   await page.goto(process.env.MME_TEST_URL || 'http://127.0.0.1:18761/?t=qa');
   const started=Date.now();
   const status=await page.evaluate(async item=>{
    const {openStudio}=await import('/studio.js');
    await openStudio({path:item.path,name:item.path.split(/[\\/]/).pop()});
    return document.getElementById('studioStatus').textContent;
   },item);
   assert.match(status,/^[\d,]+ triangles/,status);
   if(item.triangles)assert.ok(status.startsWith(item.triangles.toLocaleString('en-GB')+' triangles'),status);
   await page.waitForFunction(()=>document.getElementById('studioVolume').textContent.startsWith('Estimated solid volume:'),{},{timeout:180000});
   await page.screenshot({path:path.join(process.env.MME_SCREENSHOT_DIR || require('node:os').tmpdir(),'meshkeep-large-'+index+'.png')});
   assert.deepEqual(errors,[]);
   const after=fs.statSync(item.path);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
   console.log(JSON.stringify({name:path.basename(item.path),bytes:before.size,seconds:(Date.now()-started)/1000,status}));
  } finally {await browser.close()}
 }
})().catch(e=>{console.error(e);process.exit(1)});
