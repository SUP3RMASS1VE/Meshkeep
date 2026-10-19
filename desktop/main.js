// Electron shell for Meshkeep: starts the Python server sidecar,
// waits for it to be ready, and shows it in a native window.
const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Keep existing window preferences, localStorage and the single-instance lock
// available after the display-name change.
const legacyUserData = path.join(app.getPath("appData"), "Model Meta Editor");
if (fs.existsSync(legacyUserData)) app.setPath("userData", legacyUserData);

const READY_RE = /^READY_URL (http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)$/;
let sidecar = null;
let win = null;
let stderrTail = "";
let trustedOrigin = null;

function sidecarCommand() {
  const args = ["--electron", "--root", os.homedir(), "--port", "8756"];
  const executable = process.platform === 'win32' ? 'mme-server.exe' : 'mme-server';
  if (app.isPackaged) {
    return { cmd: path.join(process.resourcesPath, "mme-server", executable), args };
  }
  const built = path.join(__dirname, process.platform === 'win32' ? 'sidecar-dist-win' : 'sidecar-dist', "mme-server", executable);
  if (fs.existsSync(built)) return { cmd: built, args };
  if (process.platform === 'win32') {
    const local = path.join(__dirname, '..', 'build', 'pyenv-win', 'Scripts', 'python.exe');
    return { cmd: fs.existsSync(local) ? local : 'py', args: [...(fs.existsSync(local) ? [] : ['-3']), path.join(__dirname, '..', 'app.py'), ...args] };
  }
  return { cmd: "python3", args: [path.join(__dirname, "..", "app.py"), ...args] };
}

function startSidecar() {
  return new Promise((resolve, reject) => {
    const { cmd, args } = sidecarCommand();
    sidecar = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let done = false;
    const timer = setTimeout(() => finish(new Error("Server did not start within 20 s.")), 20000);

    function finish(err, url) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(url);
    }

    sidecar.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = READY_RE.exec(line);
        if (m) finish(null, m[1]);
      }
    });
    sidecar.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      process.stderr.write(s);
      stderrTail = (stderrTail + s).slice(-2000);
    });
    sidecar.on("error", (err) => finish(err));
    sidecar.on("exit", (code) => {
      sidecar = null;
      finish(new Error(`Server exited before it was ready (code ${code}).`));
    });
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("Server did not respond."));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

function killSidecar() {
  const proc = sidecar;
  if (!proc || proc.exitCode !== null) return;
  try { proc.kill("SIGTERM"); } catch (_) { return; }
  setTimeout(() => {
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch (_) {}
    }
  }, 2000).unref();
}

function insideHome(file, home) {
  const relative = path.relative(home, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function installWorkspaceBridge() {
  const settingsPath = path.join(app.getPath('userData'), 'meshkeep-slicer.json');
  let slicerPath = null;
  try { slicerPath = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).path; } catch (_) {}
  function trusted(event) {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== trustedOrigin) throw new Error('Untrusted app window.');
  }
  const status = () => ({name: slicerPath ? path.basename(slicerPath).replace(/\.(app|exe)$/i, '') : null, available: !!slicerPath && fs.existsSync(slicerPath)});
  ipcMain.handle('meshkeep:slicer', event => { trusted(event); return status(); });
  ipcMain.handle('meshkeep:chooseFolder', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(win, {title: 'Choose a model folder', properties: ['openDirectory'], defaultPath: os.homedir()});
    if (result.canceled) return null;
    const folder = fs.realpathSync(result.filePaths[0]);
    const home = fs.realpathSync(os.homedir());
    if (!insideHome(folder, home)) throw new Error('Choose a folder inside your home folder.');
    return folder;
  });
  ipcMain.handle('meshkeep:chooseSlicer', async event => {
    trusted(event);
    const windows = process.platform === 'win32';
    const result = await dialog.showOpenDialog(win, {title: 'Choose your slicer application', defaultPath: windows ? (process.env.ProgramFiles || os.homedir()) : '/Applications', properties: ['openFile'], filters: [{name: 'Applications', extensions: [windows ? 'exe' : 'app']}]});
    if (result.canceled) return {...status(), canceled: true};
    const selected = fs.realpathSync(result.filePaths[0]);
    if (windows ? (!/\.exe$/i.test(selected) || !fs.statSync(selected).isFile()) : (!selected.endsWith('.app') || !fs.statSync(selected).isDirectory())) throw new Error(windows ? 'Choose a Windows slicer executable (.exe).' : 'Choose a macOS slicer application.');
    fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
    fs.writeFileSync(settingsPath, JSON.stringify({path: selected}));
    slicerPath = selected; return status();
  });
  ipcMain.handle('meshkeep:sendToSlicer', async (event, paths) => {
    trusted(event);
    if (!status().available) throw new Error('Choose your slicer application first.');
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) throw new Error('Select up to 100 models.');
    const home = fs.realpathSync(os.homedir());
    const models = paths.map(value => {
      if (typeof value !== 'string') throw new Error('Invalid model path.');
      const file = fs.realpathSync(value);
      if (!insideHome(file, home) || !fs.statSync(file).isFile() || !['.3mf','.stl','.obj','.ply','.amf'].includes(path.extname(file).toLowerCase())) throw new Error('Choose a supported model in your home folder.');
      return file;
    });
    await new Promise((resolve, reject) => {
      const windows = process.platform === 'win32';
      const child = spawn(windows ? slicerPath : '/usr/bin/open', windows ? models : ['-a', slicerPath, ...models], {stdio: 'ignore', windowsHide: true, detached: windows});
      child.on('error', reject);
      if (windows) child.once('spawn', () => { child.unref(); resolve(); });
      else child.on('exit', code => code === 0 ? resolve() : reject(new Error('The slicer could not be opened. Choose it again in settings.')));
    });
    return {sent: models.length, name: status().name};
  });
}

function buildMenu() {
  const template = [
    {
      label: process.platform === 'darwin' ? app.name : 'File',
      submenu: process.platform === 'darwin' ? [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", accelerator: "Cmd+Q" },
      ] : [{ role: 'about' }, { type: 'separator' }, { role: 'quit', accelerator: 'Ctrl+Q' }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url) {
  const origin = new URL(url).origin;
  trustedOrigin = origin;
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    show: false,
    title: "Meshkeep",
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target) && new URL(target).origin !== origin) {
      shell.openExternal(target);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });
  win.on("closed", () => { win = null; });
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    installWorkspaceBridge();
    // No downloads exist today; save via the standard dialog if one appears.
    session.defaultSession.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(os.homedir(), "Downloads", item.getFilename()) });
    });
    try {
      const url = await startSidecar();
      await waitForServer(url);
      createWindow(url);
    } catch (err) {
      dialog.showErrorBox("Meshkeep could not start",
        `${err.message}\n\n${stderrTail}`.trim());
      killSidecar();
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    killSidecar();
    app.quit();
  });
  app.on("before-quit", killSidecar);
  process.on("exit", () => {
    if (sidecar && sidecar.exitCode === null) {
      try { sidecar.kill("SIGKILL"); } catch (_) {}
    }
  });
}
