// Exercise the real updater against an isolated HTTP feed; never run an installer.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createHash} = require('node:crypto');
const modules = path.resolve(process.env.MME_UPDATER_MODULES || path.join(__dirname, '../desktop/node_modules'));
const {NsisUpdater} = require(path.join(modules, 'electron-updater'));
const {ElectronHttpExecutor} = require(path.join(modules, 'electron-updater/out/electronHttpExecutor'));
const {createUpdater} = require('../desktop/updater');

test('real feed detects only newer stable versions and rejects a corrupt download', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'meshkeep-feed-'));
  const body = Buffer.from('Synthetic update payload: never executed.');
  const hash = createHash('sha512').update(body).digest('base64');
  let version = '2.0.5', corrupt = false, downloads = 0, missingManifest = true;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/latest')) {
      if (missingManifest) { res.statusCode = 404; res.end('Not Found'); return; }
      res.end(JSON.stringify({version, files: [{url: 'fixture.exe', sha512: hash, size: body.length}], path: 'fixture.exe', sha512: hash, releaseDate: '2026-10-24T00:00:00Z'}));
    } else if (req.url.startsWith('/fixture.exe')) {
      downloads++; res.end(corrupt ? Buffer.from('tampered') : body);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = path.join(temp, 'app-update.yml');
    await fs.writeFile(config, JSON.stringify({provider: 'generic', url, updaterCacheDirName: 'meshkeep-test'}));
    const updater = new NsisUpdater(null, {version: '2.0.4', name: 'Meshkeep', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: temp, baseCachePath: temp, whenReady: async () => {},
      quit: () => assert.fail('Must never quit in a download test'), relaunch() {}, onQuit() {}});
    // Keep the updater's actual download and hash verification; replace only
    // Electron's network transport so this test can run under plain Node.
    updater.httpExecutor = new ElectronHttpExecutor();
    updater.httpExecutor.createRequest = (options, callback) => http.request(options, callback);
    updater.httpExecutor.addRedirectHandlers = () => {}; // this local fixture never redirects
    updater.setFeedURL({provider: 'generic', url});
    updater.disableDifferentialDownload = true;
    updater.logger = {info() {}, warn() {}, error() {}, debug() {}};
    const service = createUpdater({autoUpdater: updater, currentVersion: '2.0.4', enabled: true,
      canInstall: true, publish() {}, confirmInstall: async () => assert.fail('Must never install'), beforeInstall: async () => {}});
    await service.check();
    assert.equal(service.getState().status, 'unavailable');
    assert.doesNotMatch(service.getState().message, /internet|connection/i);
    missingManifest = false;
    for (const stable of ['2.0.4', '2.0.3', '2.0.5-beta.1']) {
      version = stable; await service.check(); assert.equal(service.getState().status, 'current', stable);
    }
    version = '2.0.5'; await service.check();
    assert.equal(service.getState().status, 'available'); assert.equal(downloads, 0);
    corrupt = true; await service.download(); assert.equal(service.getState().status, 'error');
    corrupt = false; await service.check(); await service.download();
    assert.equal(service.getState().status, 'downloaded');
    assert.deepEqual(await fs.readFile(updater.installerPath), body);
    assert.equal(downloads, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, {recursive: true, force: true});
  }
});
