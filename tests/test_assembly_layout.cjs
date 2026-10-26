const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const modulePromise=import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../web/assembly-layout.js'),'utf8')).toString('base64'));
const box=(x,y,z)=>({min:[-x/2,-y/2,-z/2],max:[x/2,y/2,z/2]});
function placed(bounds,positions){return bounds.map((b,i)=>({min:b.min.map((v,a)=>v+positions[i][a]),max:b.max.map((v,a)=>v+positions[i][a])}))}
function verify(bounds,positions){
 assert.equal(positions.length,bounds.length);
 const boxes=placed(bounds,positions);
 for(let i=0;i<boxes.length;i++){
  assert.ok(positions[i].every(Number.isFinite));assert.equal(boxes[i].min[2],0);
  for(let j=0;j<i;j++)assert.ok(boxes[i].min[0]>=boxes[j].max[0]||boxes[j].min[0]>=boxes[i].max[0]||boxes[i].min[1]>=boxes[j].max[1]||boxes[j].min[1]>=boxes[i].max[1],`pieces ${i} and ${j} overlap`);
 }
 return boxes;
}
test('multi-plate overview does not inflate every STL slot',async()=>{
 const {compactPlacements}=await modulePromise;
 const bounds=[box(2345,1938,340),...Array.from({length:28},(_,i)=>box(180+i*5,260+i*2,200))];
 const positions=compactPlacements(bounds),boxes=verify(bounds,positions);
 for(const axis of [0,1])assert.ok(Math.max(...boxes.map(b=>b.max[axis]))-Math.min(...boxes.map(b=>b.min[axis]))<5000);
 assert.deepEqual(compactPlacements(bounds),positions);
});
test('variable and off-centre bounds pack without intersections at scene limit',async()=>{
 const {compactPlacements}=await modulePromise;
 const bounds=Array.from({length:200},(_,i)=>({min:[i,2*i,-3],max:[i+10+i%19,2*i+4+i%37,7]}));
 verify(bounds,compactPlacements(bounds));
 assert.deepEqual(compactPlacements([]),[]);
 assert.deepEqual(compactPlacements([box(10,20,30)]),[[0,0,15]]);
});
