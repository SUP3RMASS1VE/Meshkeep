const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/updates.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const nodes = new Map(); let push, show; const calls = [];
  let state = {status: 'idle', currentVersion: '2.0.4', version: null, canInstall: true, percent: 0, revision: 0};
  const bridge = {
    updateStatus: async () => state,
    checkUpdate: async () => { calls.push('check'); return state; },
    downloadUpdate: async () => { calls.push('download'); return state; },
    installUpdate: async () => { calls.push('install'); return state; },
    updateRelease: async () => { calls.push('release'); },
    onUpdateState: cb => { push = cb; return () => {}; }, onShowUpdates: cb => { show = cb; return () => {}; },
  };
  const node = id => { if (!nodes.has(id)) nodes.set(id, {hidden: true, textContent: ''}); return nodes.get(id); };
  vm.runInNewContext(source, {window: {meshkeepDesktop: bridge, addEventListener() {}}, document: {getElementById: node}});
  return {node, calls, show: () => show(), push: patch => { state = {...state, revision: state.revision + 1, ...patch}; push(state); }, stale: () => push({...state, status: 'idle', revision: 0})};
}

test('startup stays quiet unless an update is available, with explicit download and restart', async () => {
  const f = setup(); await tick();
  f.push({status: 'checking'}); assert.equal(f.node('updateBanner').hidden, true);
  f.push({status: 'available', version: '2.0.5'});
  assert.equal(f.node('updateBanner').hidden, false);
  assert.equal(f.node('updateAction').textContent, 'Download update');
  assert.deepEqual(f.calls, []);
  f.node('updateAction').onclick(); await tick(); assert.deepEqual(f.calls, ['download']);
  f.push({status: 'downloading', percent: 42.9});
  assert.equal(f.node('updateProgress').value, 42.9);
  assert.equal(f.node('updateAction').hidden, true);
  f.node('dismissUpdate').onclick();
  f.push({status: 'downloading', percent: 68}); assert.equal(f.node('updateBanner').hidden, true);
  f.push({status: 'downloaded', percent: 100}); assert.equal(f.node('updateBanner').hidden, false);
  f.stale(); assert.equal(f.node('updateAction').textContent, 'Restart and install');
  f.node('updateAction').onclick(); await tick(); assert.deepEqual(f.calls, ['download', 'install']);
});

test('offline startup stays quiet; manual checks expose retry; unsigned Mac uses Releases', async () => {
  const f = setup(); await tick();
  f.push({status: 'error', message: 'Offline'}); assert.equal(f.node('updateBanner').hidden, true);
  f.show(); assert.equal(f.node('updateBanner').hidden, false);
  assert.equal(f.node('updateAction').textContent, 'Try again');
  f.push({status: 'available', version: '<script>test</script>', canInstall: false});
  assert.equal(f.node('updateAction').hidden, true);
  assert.equal(f.node('updateRelease').hidden, false);
  assert.match(f.node('updateMessage').textContent, /manual update/);
  f.node('updateRelease').onclick(); await tick(); assert.deepEqual(f.calls, ['release']);
});


test('missing release assets show a specific notice without claiming the app is up to date', async () => {
  const f = setup(); await tick();
  f.push({status: 'unavailable', message: 'The published GitHub release does not include automatic update files yet.'});
  assert.equal(f.node('updateBanner').hidden, true);
  f.show();
  assert.equal(f.node('updateBanner').hidden, false);
  assert.equal(f.node('updateTitle').textContent, 'Automatic updates are not available yet');
  assert.equal(f.node('updateAction').textContent, 'Check again');
  assert.equal(f.node('updateRelease').hidden, false);
  assert.doesNotMatch(f.node('updateMessage').textContent, /internet|connection|up to date/i);
  f.push({status: 'error', failedOperation: 'check', message: 'Try again.'});
  assert.equal(f.node('updateTitle').textContent, 'Could not check for updates');
});
