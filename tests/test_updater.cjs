const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createUpdater} = require('../desktop/updater');

function fixture(options = {}) {
  const autoUpdater = new EventEmitter();
  const events = [];
  autoUpdater.checkForUpdates = async () => { events.push('check'); autoUpdater.emit('update-available', {version: '2.0.5'}); };
  autoUpdater.downloadUpdate = async () => {
    events.push('download');
    autoUpdater.emit('download-progress', {percent: 45.5});
    autoUpdater.emit('update-downloaded', {version: '2.0.5'});
  };
  autoUpdater.quitAndInstall = (...args) => events.push(['install', ...args]);
  const states = [];
  const service = createUpdater({autoUpdater, currentVersion: '2.0.4', enabled: true, canInstall: true,
    publish: state => states.push(state), confirmInstall: async () => true,
    beforeInstall: async () => { events.push('stop-sidecar'); }, ...options});
  return {autoUpdater, events, states, service};
}

test('checking never downloads; installation is explicit and waits for the sidecar', async () => {
  const f = fixture();
  assert.equal(f.autoUpdater.autoDownload, false);
  assert.equal(f.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(f.autoUpdater.allowPrerelease, false);
  assert.equal(f.autoUpdater.allowDowngrade, false);
  await f.service.install();
  await f.service.download();
  assert.deepEqual(f.events, []);
  await f.service.check();
  assert.deepEqual(f.events, ['check']);
  assert.equal(f.service.getState().status, 'available');
  await f.service.download();
  assert.deepEqual(f.events, ['check', 'download']);
  assert.equal(f.service.getState().status, 'downloaded');
  assert.ok(f.states.some(state => state.status === 'downloading' && state.percent === 45.5));
  await f.service.check(); // checking again must not discard a downloaded update
  await f.service.install();
  assert.deepEqual(f.events, ['check', 'download', 'stop-sidecar', ['install', false, true]]);
  await f.service.install();
  assert.equal(f.events.filter(event => Array.isArray(event)).length, 1);
});

test('canceling the restart leaves the downloaded update ready', async () => {
  const f = fixture({confirmInstall: async () => false});
  await f.service.check(); await f.service.download(); await f.service.install();
  assert.equal(f.service.getState().status, 'downloaded');
  assert.deepEqual(f.events, ['check', 'download']);
});

test('development runs never check or download; unsigned Macs can only check', async () => {
  const dev = fixture({enabled: false, canInstall: false});
  await dev.service.check(); await dev.service.download(); await dev.service.install();
  assert.equal(dev.service.getState().status, 'disabled');
  assert.deepEqual(dev.events, []);
  const mac = fixture({canInstall: false});
  await mac.service.check(); await mac.service.download(); await mac.service.install();
  assert.deepEqual(mac.events, ['check']);
  assert.equal(mac.service.getState().status, 'available');
});

test('overlapping checks and downloads are deduplicated', async () => {
  const f = fixture(); let finish;
  f.autoUpdater.checkForUpdates = () => new Promise(resolve => { finish = resolve; f.events.push('check'); });
  const first = f.service.check(); await f.service.check();
  assert.deepEqual(f.events, ['check']);
  f.autoUpdater.emit('update-available', {version: '2.0.5'}); finish(); await first;
  f.autoUpdater.downloadUpdate = () => new Promise(resolve => { finish = resolve; f.events.push('download'); });
  const download = f.service.download(); await f.service.download(); await f.service.check();
  assert.deepEqual(f.events, ['check', 'download']);
  finish(); await download;
});

test('network and verification errors are recoverable and never install', async () => {
  const f = fixture();
  f.autoUpdater.checkForUpdates = async () => { throw new Error('offline'); };
  await f.service.check();
  assert.equal(f.service.getState().status, 'error');
  f.autoUpdater.checkForUpdates = async () => f.autoUpdater.emit('update-available', {version: '2.0.5'});
  await f.service.check();
  f.autoUpdater.downloadUpdate = async () => { f.autoUpdater.emit('error', new Error('checksum mismatch')); throw new Error('checksum mismatch'); };
  await f.service.download(); await f.service.install();
  assert.equal(f.service.getState().status, 'error');
  assert.deepEqual(f.events, []);
  f.autoUpdater.checkForUpdates = async () => f.autoUpdater.emit('update-not-available', {version: '2.0.4'});
  await f.service.check();
  assert.equal(f.service.getState().status, 'current');
});

test('sidecar failure prevents installation and reports an error', async () => {
  const f = fixture({beforeInstall: async () => { throw new Error('still running'); }});
  await f.service.check(); await f.service.download(); await f.service.install();
  assert.equal(f.service.getState().status, 'error');
  assert.deepEqual(f.events, ['check', 'download']);
});


test('missing published update files are distinct from connectivity errors', async () => {
  const f = fixture();
  f.autoUpdater.checkForUpdates = async () => {
    const error = Object.assign(new Error('Cannot find latest-mac.yml in the latest release artifacts'), {code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'});
    f.autoUpdater.emit('error', error);
    throw error;
  };
  await f.service.check();
  assert.equal(f.service.getState().status, 'unavailable');
  assert.match(f.service.getState().message, /does not include automatic update files/);
  assert.doesNotMatch(f.service.getState().message, /internet|connection/i);
  await f.service.download(); await f.service.install();
  assert.deepEqual(f.events, []);
  f.autoUpdater.checkForUpdates = async () => { throw Object.assign(new Error('offline'), {code: 'ENOTFOUND'}); };
  await f.service.check();
  assert.equal(f.service.getState().status, 'error');
  assert.equal(f.service.getState().failedOperation, 'check');
  f.autoUpdater.checkForUpdates = async () => f.autoUpdater.emit('update-available', {version: '2.0.5'});
  await f.service.check();
  assert.equal(f.service.getState().status, 'available');
});
