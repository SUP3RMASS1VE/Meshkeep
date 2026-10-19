const {chromium} = require(process.env.MME_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
 const browser = await chromium.launch({headless:true,executablePath:process.env.MME_CHROME_PATH || undefined,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const page = await browser.newPage({viewport:{width:1500,height:1100}});
  page.setDefaultTimeout(120000);
  await page.goto('http://127.0.0.1:18759/?t=qa');
  const result = await page.evaluate(async () => {
   const {decodePaint,paintedFacets}=await import('/paint3mf.js');
   const {parse3MF}=await import('/threemf.js');
   const {zipSync,strToU8}=await import('three/addons/libs/fflate.module.js');
   const THREE=await import('three');
   const check=(ok,message)=>{if(!ok)throw Error(message)};
   const triangle=[[0,0,0],[2,0,0],[0,2,0]];
   const area=t=>new THREE.Vector3(...t[1]).sub(new THREE.Vector3(...t[0])).cross(new THREE.Vector3(...t[2]).sub(new THREE.Vector3(...t[0]))).z/2;
   for (const [text,state] of [['0',0],['4',1],['8',2],['0C',3],['1C',4],['0FC',18],['1FFC',34]]) check(decodePaint(text).state===state,'Filament state '+text);
   // Spatial assertions detect reversed child order and special-side rotation errors.
   for (const [split,side,code] of [[1,0,'1'],[1,1,'5'],[1,2,'9'],[2,0,'2'],[2,1,'6'],[2,2,'A'],[3,0,'3']]) {
    const text=(split===1?'48':split===2?'480C':'480C1C')+code;
    const leaves=[];paintedFacets(decodePaint(text),triangle,(t,s)=>leaves.push({t,s}));
    check(leaves.length===split+1,'Leaf count');
    check(Math.abs(leaves.reduce((a,l)=>a+area(l.t),0)-2)<1e-10,'Area and winding preserved');
    check(leaves.every((l,i)=>l.s===i+1),'Child order');
    check(leaves[0].t[0].every((v,i)=>v===triangle[side][i]),'Special side');
   }
   const nested=decodePaint('48411');
   check(nested.leaves===3,'Nested split');
   for(const text of ['', 'G','1','84','8888F','00000000000000000000001']) {
    let rejected=false;try{decodePaint(text)}catch(_){rejected=true}check(rejected,'Reject invalid paint '+text);
   }
   const build=(paint,extra='',config='',json={filament_colour:['#676868','#00FF00','#FAFBFF']})=>parse3MF(zipSync(Object.fromEntries(Object.entries({
    '_rels/.rels':'<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/a.model"/></Relationships>',
    '3D/a.model':`<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${extra}<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="2" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" ${paint}/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
    'Metadata/project_settings.config':JSON.stringify(json), 'Metadata/model_settings.config':config || '<config/>'
   }).map(([k,v])=>[k,strToU8(v)]))));
   const meshes=o=>{const a=[];o.traverse(p=>{if(p.isMesh)a.push(p)});return a};
   const colorHex=(m,index=0)=>new THREE.Color().fromBufferAttribute(m.geometry.attributes.color,index).getHexString();
   const painted=meshes(build('paint_color="480CA"'))[0];
   check(painted.geometry.attributes.position.count===9,'Paint split geometry');
   check([0,3,6].map(i=>colorHex(painted,i)).join(',')==='676868,00ff00,fafbff','Palette colours');
   const assigned=meshes(build('', '', '<config><object id="1"><metadata key="extruder" value="2"/></object></config>'))[0];
   check(colorHex(assigned)==='00ff00','Object filament assignment');
   const core=meshes(build('pid="9" p1="0"','<basematerials id="9"><base displaycolor="#FF0000"/></basematerials>'))[0];
   check(colorHex(core)==='ff0000','Core material precedence');
   const bad=build('paint_color="1"');check(bad.userData.warnings.length>0,'Malformed paint warning');
   const plain=meshes(build('','', '',{}))[0];check(!plain.geometry.attributes.color,'Uncoloured model fallback');
   return 'All split types, rotations, nested trees, extended filament IDs, malformed data, palette, assignment and standard core colours';
  });
  console.log('COLOUR_PASS',result);
  if(process.env.MME_COLOUR_MODEL) {
   const bytes=fs.readFileSync(process.env.MME_COLOUR_MODEL);
   await page.route('**/api/model?**',route=>route.fulfill({status:200,body:bytes,headers:{'Content-Type':'application/octet-stream','X-Model-Stamp':'1,2,3'}}));
   const actual=await page.evaluate(async () => {
    const {loadModel,openStudio}=await import('/studio.js');
    const THREE=await import('three');
    const loaded=await loadModel('/colour.3mf');
    const counts={};loaded.object.traverse(p=>{if(!p.isMesh)return;const c=p.geometry.attributes.color;for(let i=0;i<c.count;i+=3){const hex=new THREE.Color().fromBufferAttribute(c,i).getHexString();counts[hex]=(counts[hex]||0)+1;}});
    const {dispose}=await import('/studio.js');dispose(loaded.object);
    await openStudio({path:'/colour.3mf',name:'SUP3R zombie alien.3mf'});
    return {triangles:loaded.triangles,counts};
   });
   assert.ok(actual.counts['676868']>1800000);assert.ok(actual.counts['00ff00']>45000);assert.ok(actual.counts['fafbff']>3000);
   console.log('ACTUAL_MODEL_PASS',actual);
   await page.screenshot({path:require('node:path').join(process.env.MME_SCREENSHOT_DIR || require('node:os').tmpdir(), 'meshkeep-colour-fix.png')});
  }
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
