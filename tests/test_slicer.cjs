/* Native bridge tests with a fake OS launcher: no real applications are opened. */
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
(async()=>{for(const platform of ['darwin','win32']){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'meshkeep-slicer-')),home=path.join(temp,'home'),data=path.join(temp,'prefs'),application=path.join(temp,'TestSlicer.app');
 fs.mkdirSync(home);if(platform==='win32')fs.writeFileSync(application+'.exe','fake');else fs.mkdirSync(application);const selected=platform==='win32'?application+'.exe':application;const file=path.join(home,'model & ü.stl');fs.writeFileSync(file,'solid t\nendsolid t');
 const handlers=new Map(),launches=[];const app={getPath:()=>data,setPath(){},requestSingleInstanceLock:()=>false,quit(){}};
 const electron={app,ipcMain:{handle:(key,handler)=>handlers.set(key,handler)},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[selected]})}};
 const context=vm.createContext({console,URL,process:{platform,env:{}},setTimeout,clearTimeout,require:name=>{
  if(name==='electron')return electron;
  if(name==='os')return {homedir:()=>home};
  if(name==='child_process')return {spawn:(command,args,options)=>{launches.push({command,args,options});const child=new EventEmitter();child.unref=()=>{};setTimeout(()=>{child.emit('spawn');child.emit('exit',0)},0);return child}};
  return require(name);
 }});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/main.js'),'utf8'),context);
 const frame={url:'http://127.0.0.1:1234/?t=private'},contents={mainFrame:frame};context.testWindow={webContents:contents};
 vm.runInContext("win=testWindow;trustedOrigin='http://127.0.0.1:1234';installWorkspaceBridge()",context);
 const event={sender:contents,senderFrame:frame};
 assert.equal((await handlers.get('meshkeep:chooseSlicer')(event)).name,platform==='win32'?'TestSlicer.app':'TestSlicer');
 assert.equal((await handlers.get('meshkeep:sendToSlicer')(event,[file])).sent,1);
 assert.equal(launches[0].command,platform==='win32'?fs.realpathSync(selected):'/usr/bin/open');assert.deepEqual(Array.from(launches[0].args),platform==='win32'?[fs.realpathSync(file)]:['-a',fs.realpathSync(selected),fs.realpathSync(file)]);
 assert.equal(launches[0].options.windowsHide,true);
 const outside=path.join(temp,'outside.stl');fs.writeFileSync(outside,'fixture');
 await assert.rejects(()=>handlers.get('meshkeep:sendToSlicer')(event,[outside]));
 await assert.rejects(()=>handlers.get('meshkeep:sendToSlicer')({sender:{},senderFrame:frame},[file]),/Untrusted/);
 await assert.rejects(()=>handlers.get('meshkeep:sendToSlicer')(event,['/etc/hosts']));
 frame.url='https://example.org/';assert.throws(()=>handlers.get('meshkeep:slicer')(event),/Untrusted/);
 assert.equal(launches.length,1);fs.rmSync(temp,{recursive:true,force:true});console.log('SLICER_PASS',platform);
 }
})().catch(error=>{console.error(error);process.exit(1)});
