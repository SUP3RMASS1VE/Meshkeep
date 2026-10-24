const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const main = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');

test('update commands reject foreign windows, subframes and untrusted origins', async () => {
  const handlers = new Map(), calls = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { calls.push('check'); updater.emit('update-available', {version: '2.0.5'}); };
  updater.downloadUpdate = async () => { calls.push('download'); updater.emit('update-downloaded', {version: '2.0.5'}); };
  const frame = {url: 'http://127.0.0.1:1234/?t=test'};
  const contents = {mainFrame: frame, send() {}, getURL: () => frame.url};
  const win = {webContents: contents, isDestroyed: () => false, setProgressBar() {}};
  const electron = {app: {isPackaged: true, getVersion: () => '2.0.4', getPath: () => '/nonexistent/meshkeep-test', requestSingleInstanceLock: () => false, quit() {}},
    ipcMain: {handle: (channel, fn) => handlers.set(channel, fn)}, shell: {openExternal: async url => calls.push(url)}};
  const context = vm.createContext({console, URL, process: {platform: 'win32', env: {}}, setTimeout, clearTimeout,
    require: name => name === 'electron' ? electron : name === 'electron-updater' ? {autoUpdater: updater} : name === './updater' ? require('../desktop/updater') : require(name),
    testWindow: win});
  vm.runInContext(main, context);
  vm.runInContext("win=testWindow;trustedOrigin='http://127.0.0.1:1234';installUpdateBridge()", context);
  const trusted = {sender: contents, senderFrame: frame};
  for (const handler of handlers.values()) {
    assert.throws(() => handler({sender: {}, senderFrame: frame}), /Untrusted/);
    assert.throws(() => handler({sender: contents, senderFrame: {url: frame.url}}), /Untrusted/);
    frame.url = 'https://example.com/';
    assert.throws(() => handler(trusted), /Untrusted/);
    frame.url = 'http://127.0.0.1:1234/?t=test';
  }
  await handlers.get('meshkeep:checkUpdate')(trusted);
  await handlers.get('meshkeep:downloadUpdate')(trusted, 'https://evil.example/installer.exe');
  await handlers.get('meshkeep:updateRelease')(trusted, 'https://evil.example/');
  assert.deepEqual(calls, ['check', 'download', 'https://github.com/SUP3RMASS1VE/Meshkeep/releases/latest']);
});

test('preload exposes fixed updater methods without exposing IPC events', async () => {
  const listeners = new Map(), calls = [];
  let bridge;
  const electron = {contextBridge: {exposeInMainWorld: (_name, value) => { bridge = value; }}, ipcRenderer: {
    invoke: (...args) => { calls.push(args); }, on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); },
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop/preload.js'), 'utf8'), {require: () => electron});
  bridge.downloadUpdate('untrusted path');
  assert.deepEqual(calls, [['meshkeep:downloadUpdate']]);
  let seen;
  const off = bridge.onUpdateState((...args) => { seen = args; });
  listeners.get('meshkeep:updateState')({sender: 'privileged'}, {status: 'available'});
  assert.deepEqual(seen, [{status: 'available'}]);
  off(); assert.equal(listeners.size, 0);
});
