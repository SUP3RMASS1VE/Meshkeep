const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'meshkeep-electron-'));app.setPath('userData',path.join(temporary,'profile'));
app.commandLine.appendSwitch('use-angle','swiftshader');app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.whenReady().then(async()=>{
 let win;
 try{
  const root=(await(await fetch('http://127.0.0.1:18759/api/config?t=qa')).json()).root;
  const application=path.join(temporary,process.platform==='win32'?'FakeSlicer.exe':'FakeSlicer.app');if(process.platform==='win32')fs.writeFileSync(application,'fake');else fs.mkdirSync(application);const launches=[];
  win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.resolve(__dirname,'../../desktop/preload.js')}});
  const main=fs.readFileSync(path.resolve(__dirname,'../../desktop/main.js'),'utf8');
  const source=main.slice(main.indexOf('function insideHome('),main.indexOf('function buildMenu()'));
  const install=new Function('app','ipcMain','fs','path','os','dialog','spawn','win','trustedOrigin',source+';return installWorkspaceBridge;');
  install(app,ipcMain,fs,path,{homedir:()=>root},{showOpenDialog:async()=>({canceled:false,filePaths:[application]})},(command,args)=>{launches.push({command,args});const child=new EventEmitter();child.unref=()=>{};setTimeout(()=>{child.emit('spawn');child.emit('exit',0)},0);return child},win,'http://127.0.0.1:18759')();
  await win.loadURL('http://127.0.0.1:18759/?t=qa&open='+encodeURIComponent(root+'/Workshop cube.stl'));
  const wait=async script=>{const end=Date.now()+20000;while(Date.now()<end){if(await win.webContents.executeJavaScript(script))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timeout '+script)};
  await wait('!document.getElementById("single").hidden');
  const result=await win.webContents.executeJavaScript(`(async()=>{await window.meshkeepDesktop.chooseSlicer();return window.meshkeepDesktop.sendToSlicer([${JSON.stringify(root+'/Workshop cube.stl')}])})()`);
  if(result.sent!==1||launches.length!==1||launches[0].command!==(process.platform==='win32'?fs.realpathSync(application):'/usr/bin/open'))throw new Error('Native bridge failed');
  await win.webContents.executeJavaScript('document.getElementById("openStudio").click()');
  await wait('document.getElementById("studioVolume").textContent.includes("8.000 cm³")');
  const inspection=await win.webContents.executeJavaScript('document.getElementById("studioVolume").textContent');
  console.log('ELECTRON_WORKSPACE_PASS',JSON.stringify({sent:result.sent,inspection}));win.destroy();
  // Chromium keeps profile files locked until the Windows process exits.
  if(process.platform!=='win32')fs.rmSync(temporary,{recursive:true,force:true});
  app.exit(0);
 }catch(error){console.error(error);if(win)win.destroy();app.exit(1)}
});
