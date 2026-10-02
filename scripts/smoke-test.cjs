// Run via npm run test:app. Requires a desktop session (or xvfb on Linux).
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { unzipSync } = require('fflate');
const { binaryStl, threeMf, writeSamples, largeStl, multipart3mf } = require('./sample-models.cjs');

const outputRoot = process.env.MESHFLASK_SMOKE_OUTPUT ? path.resolve(process.env.MESHFLASK_SMOKE_OUTPUT) : os.tmpdir();
fs.mkdirSync(outputRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(outputRoot, 'meshflask-app-test-'));
const profile = path.join(temp, 'profile');
const models = path.join(temp, 'models');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ version: 1, externalApps: [], logLevel: 'debug' }));
app.setPath('userData', profile);
delete process.env.ELECTRON_RENDERER_URL;
const entries = [];
require('electron-log/main').hooks.push((message, _transport, name) => {
  if (name === 'file') entries.push(message);
  return message;
});
const results = [];
let passed = false;
let window;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => void fail(new Error('App test exceeded 6 minutes')), 360000);
async function waitFor(label, check, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(label) { results.push(label); console.log(`APP TEST PASS: ${label}`); }
async function fail(error) {
  clearTimeout(watchdog);
  console.error('APP TEST FAILED', error, '\nArtifacts:', temp);
  fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed: false, results, error: String(error) }, null, 2));
  try {
    if (window && !window.isDestroyed()) fs.writeFileSync(path.join(temp, 'failure.png'), (await window.webContents.capturePage()).toPNG());
  } catch { /* The renderer may have crashed. */ }
  app.exit(1);
}
function ipc(method, ...args) {
  return window.webContents.executeJavaScript(`window.meshFlask[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
}
function viewerLoadedSince(index, fileId) {
  return entries.slice(index).some((entry) => entry.scope === 'viewer' && entry.data[0] === 'model loaded' && entry.data[1]?.fileId === fileId);
}
async function select(file) {
  const index = entries.length;
  await waitFor(`tile ${file.relPath}`, () => window.webContents.executeJavaScript(`(() => {
    const tile = [...document.querySelectorAll('[title]')].find(el => el.title === ${JSON.stringify(file.relPath)});
    if (!tile) return false;
    tile.click(); return true;
  })()`));
  await waitFor(`live preview ${file.relPath}`, () => viewerLoadedSince(index, file.id));
  assert.equal(await window.webContents.executeJavaScript("document.body.innerText.includes('Preview failed')"), false);
}
app.on('will-quit', () => {
  clearTimeout(watchdog);
  if (!passed) return;
  check(process.platform === 'darwin' ? 'application quits cleanly with hidden workers present' : 'closing the main window exits with hidden workers present');
  fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify({ passed, results }, null, 2));
  console.log(`APP TEST COMPLETE: ${results.length} checks. Artifacts: ${temp}`);
  if (process.env.MESHFLASK_KEEP_SMOKE !== '1' && !process.env.MESHFLASK_SMOKE_OUTPUT) fs.rmSync(temp, { recursive: true, force: true });
});

require('../out/main/index.js');
app.whenReady().then(async () => {
  // Sharp creates a valid visible texture and embedded slicer preview.
  const png = await require('sharp')({ create: { width: 64, height: 64, channels: 4, background: '#ed7542' } }).png().toBuffer();
  writeSamples(models, png);
  window = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('index.html')) || BrowserWindow.getAllWindows()[0];
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  const added = await ipc('addLibrary', { mountPath: models });
  assert.equal(added.ok, true, added.error);
  const libraryId = added.library.id;
  const query = (extra = {}) => ipc('queryFiles', { libraryId, limit: 10000, ...extra });
  const files = await waitFor('all sample thumbnails', async () => {
    const rows = await query();
    return rows.length === 11 && rows.every((row) => row.hasThumb || row.thumbError) ? rows : false;
  });
  for (const file of files) {
    if (file.filename === 'corrupt.stl') assert.ok(file.thumbError);
    else assert.equal(file.hasThumb, true, `${file.relPath}: ${file.thumbError}`);
  }
  check('STL (ASCII/binary), OBJ, PLY, glTF, GLB, 3MF thumbnails; corrupt STL rejected');
  for (const worker of BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().includes('thumb-worker.html'))) {
    const preferences = worker.webContents.getLastWebPreferences();
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.webSecurity, true);
    assert.equal(await worker.webContents.executeJavaScript('typeof window.require'), 'undefined');
  }
  check('thumbnail workers are sandboxed without Node access');
  const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await loaded;
  await delay(500);
  for (const name of ['triangle.obj', 'triangle.ply', 'external.gltf', 'embedded.glb', 'tetra.3mf', 'tetra.stl']) {
    await select(files.find((file) => file.filename === name));
  }
  check('live previews for every supported format, including external glTF buffer and texture');
  const gltf = files.find((file) => file.ext === 'gltf');
  assert.ok(entries.some((entry) => entry.scope === 'protocol' && entry.data[1]?.resource === 'checker%20texture.png'));
  const denied = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(`wh3d-file://${libraryId}/${gltf.id}?resource=${encodeURIComponent('../outside.bin')}`)}).then(r => r.status)`);
  assert.equal(denied, 404);
  check('glTF resource traversal blocked');

  const tetra = files.find((file) => file.filename === 'tetra.stl');
  await ipc('setFileNotes', libraryId, tetra.id, 'Preserve this note');
  await ipc('addTagToFile', libraryId, tetra.id, 'smoke/keep');
  const loadIndex = entries.length;
  fs.writeFileSync(path.join(models, 'tetra.stl'), binaryStl(25));
  await waitFor('selected model refreshed after filesystem update', () => viewerLoadedSince(loadIndex, tetra.id));
  const updated = (await query()).find((file) => file.id === tetra.id);
  assert.notEqual(updated.mtimeMs, tetra.mtimeMs);
  assert.equal(updated.notes, 'Preserve this note');
  check('selected preview refreshes after in-place modification');

  const original = fs.readFileSync(path.join(models, 'tetra.stl'));
  const other = files.find((file) => file.filename === 'other.stl');
  const otherBytes = fs.readFileSync(path.join(models, 'other.stl'));
  const renamed = await ipc('batchRename', libraryId, [
    { fileId: tetra.id, fromRelPath: 'tetra.stl', toRelPath: 'other.stl' },
    { fileId: other.id, fromRelPath: 'other.stl', toRelPath: 'tetra.stl' }
  ]);
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.deepEqual(fs.readFileSync(path.join(models, 'other.stl')), original);
  assert.deepEqual(fs.readFileSync(path.join(models, 'tetra.stl')), otherBytes);
  assert.equal((await ipc('undo')).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(models, 'tetra.stl')), original);
  await waitFor('rescan after undo', async () => (await ipc('getScanStatus', libraryId))?.state === 'watching');
  assert.equal((await query()).find((file) => file.id === tetra.id).notes, 'Preserve this note');
  assert.ok((await ipc('listTagsForFile', libraryId, tetra.id)).some((tag) => tag.name === 'keep' || tag.name === 'smoke/keep'));
  check('filename swap and undo preserve bytes, identity, notes, and tags');

  // Wait until chokidar has registered the directory, then modify files externally.
  await delay(1000);
  assert.equal((await ipc('duplicateFile', libraryId, tetra.id)).ok, true);
  await waitFor('duplicates hashed by watcher without rescan', async () => (await query({ duplicatesOnly: true })).filter((file) => file.contentSha256 && file.sizeBytes === original.length).length >= 2);
  check('new duplicate files receive content hashes without a rescan');

  fs.unlinkSync(path.join(models, 'tetra.stl'));
  await delay(250);
  fs.writeFileSync(path.join(models, 'tetra.stl'), binaryStl(30));
  await delay(2200);
  assert.equal((await query()).find((file) => file.relPath === 'tetra.stl')?.id, tetra.id);
  assert.equal((await query()).find((file) => file.id === tetra.id)?.notes, 'Preserve this note');
  check('unlink/recreate retains file identity and annotations');

  const protectedFile = files.find((file) => file.relPath === 'guard/protected.stl');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'protected.stl'), 'outside sentinel');
  fs.renameSync(path.join(models, 'guard'), path.join(models, '.saved-guard'));
  fs.symlinkSync(outside, path.join(models, 'guard'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await ipc('deleteFile', libraryId, protectedFile.id)).ok, false);
  assert.equal(fs.readFileSync(path.join(outside, 'protected.stl'), 'utf8'), 'outside sentinel');
  fs.unlinkSync(path.join(models, 'guard'));
  fs.renameSync(path.join(models, '.saved-guard'), path.join(models, 'guard'));
  check('trash refuses paths redirected outside the library by a symlink');

  const collection = await ipc('createCollection', libraryId, 'Smoke samples');
  const exportIds = files.filter((file) => file.filename !== 'corrupt.stl').map((file) => file.id);
  await ipc('addFilesToCollection', libraryId, collection.id, exportIds);
  let destination = path.join(temp, 'samples.zip');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  const zipped = await ipc('exportCollectionZip', libraryId, collection.id);
  assert.equal(zipped.ok, true, zipped.error);
  const contents = unzipSync(fs.readFileSync(destination));
  assert.equal(zipped.fileCount, exportIds.length + 2);
  assert.equal(Object.keys(contents).filter((name) => !name.endsWith('/')).length, exportIds.length + 2);
  assert.ok(contents['triangle.bin']);
  assert.ok(contents['checker texture.png']);
  const extracted = path.join(temp, 'extracted');
  fs.mkdirSync(extracted);
  for (const [name, bytes] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(extracted, name)), { recursive: true });
    fs.writeFileSync(path.join(extracted, name), bytes);
  }
  destination = path.join(temp, 'samples.pdf');
  const pdf = await ipc('exportContactSheet', libraryId, { collectionId: collection.id });
  assert.equal(pdf.ok, true, pdf.error);
  assert.equal(pdf.fileCount, exportIds.length);
  assert.equal(fs.readFileSync(destination).subarray(0, 5).toString(), '%PDF-');
  check('collection ZIP and PDF export contain the full sample selection');

  await ipc('patchPreferences', { logLevel: 'off' });
  await delay(200);
  const logPath = path.join(profile, 'logs', 'main.log');
  const logBefore = fs.readFileSync(logPath, 'utf8');
  await query();
  require('electron-log/main').error('SMOKE_OFF_MUST_NOT_APPEAR');
  await delay(200);
  assert.equal(fs.readFileSync(logPath, 'utf8'), logBefore);
  assert.equal((await ipc('getPreferences')).logLevel, 'off');
  await ipc('patchPreferences', { logLevel: 'debug' });
  const debugIndex = entries.length;
  await query();
  assert.ok(entries.slice(debugIndex).some((entry) => entry.data[0] === 'file query completed'));
  check('logging Off suppresses output immediately; Debug re-enables traces and persists');

  // Reopen the exported model while its original sidecars are unavailable.
  fs.renameSync(path.join(models, 'triangle.bin'), path.join(models, '.triangle.bin'));
  fs.renameSync(path.join(models, 'checker texture.png'), path.join(models, '.checker.png'));
  const reopened = await ipc('addLibrary', { mountPath: extracted });
  assert.equal(reopened.ok, true, reopened.error);
  const exportedGltf = await waitFor('exported glTF thumbnail', async () => {
    const rows = await ipc('queryFiles', { libraryId: reopened.library.id });
    return rows.find((file) => file.ext === 'gltf' && file.hasThumb);
  });
  await ipc('removeLibrary', { id: libraryId, deleteCache: false });
  const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  await select(exportedGltf);
  check('exported glTF reopens after extraction without the source library or sidecars');

  const badRoot = path.join(temp, 'bad-resources');
  fs.mkdirSync(badRoot);
  const gltfSource = JSON.parse(fs.readFileSync(path.join(extracted, 'external.gltf'), 'utf8'));
  const outsideBuffer = path.join(temp, 'outside.bin');
  fs.writeFileSync(outsideBuffer, contents['triangle.bin']);
  fs.mkdirSync(path.join(temp, 'external-assets'));
  fs.writeFileSync(path.join(temp, 'external-assets', 'mesh.bin'), contents['triangle.bin']);
  fs.symlinkSync(path.join(temp, 'external-assets'), path.join(badRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const refs = ['../outside.bin', '%2e%2e/outside.bin', 'https://example.com/mesh.bin', 'linked/mesh.bin'];
  let escapedRequests = 0;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://example.com/*'] }, (_details, callback) => { escapedRequests++; callback({ cancel: true }); });
  for (let i = 0; i < refs.length; i++) {
    const model = structuredClone(gltfSource);
    model.buffers[0].uri = refs[i];
    model.images[0].uri = `data:image/png;base64,${png.toString('base64')}`;
    fs.writeFileSync(path.join(badRoot, `blocked-${i}.gltf`), JSON.stringify(model));
  }
  const bad = await ipc('addLibrary', { mountPath: badRoot });
  assert.equal(bad.ok, true, bad.error);
  await waitFor('unsafe worker resources rejected', async () => {
    const rows = await ipc('queryFiles', { libraryId: bad.library.id });
    return rows.length === refs.length && rows.every((file) => file.thumbError && !file.hasThumb);
  });
  assert.equal(escapedRequests, 0);
  window.webContents.session.webRequest.onBeforeRequest(null);
  check('workers reject traversal, encoded traversal, external symlinks, and remote resources');

  // Exercise a real worker queue beyond the former 1000-file cutoff.
  await ipc('patchPreferences', { logLevel: 'info' });
  const largeRoot = path.join(temp, 'large');
  fs.mkdirSync(largeRoot);
  const fast3mf = threeMf(png);
  for (let i = 0; i < 1003; i++) fs.writeFileSync(path.join(largeRoot, `sample-${i}.3mf`), fast3mf);
  const large = await ipc('addLibrary', { mountPath: largeRoot });
  assert.equal(large.ok, true, large.error);
  await waitFor('1003 thumbnails through real Electron workers', async () => {
    const rows = await ipc('queryFiles', { libraryId: large.library.id, limit: 2000 });
    return rows.length === 1003 && rows.every((file) => file.hasThumb);
  }, 120000);
  check('all 1003 files receive thumbnails across automatic queue refills');

  const heavyRoot = path.join(temp, 'heavy');
  fs.mkdirSync(heavyRoot);
  fs.writeFileSync(path.join(heavyRoot, 'large.stl'), largeStl(100000));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(heavyRoot, `mesh-${i}.stl`), largeStl(2000));
  fs.writeFileSync(path.join(heavyRoot, 'multipart.3mf'), multipart3mf());
  fs.writeFileSync(path.join(heavyRoot, 'large-multipart.3mf'), multipart3mf(png, true));
  const heavy = await ipc('addLibrary', { mountPath: heavyRoot });
  assert.equal(heavy.ok, true, heavy.error);
  const started = Date.now();
  const heavyFiles = await waitFor('heavy mesh and multipart rendering', async () => {
    const rows = await ipc('queryFiles', { libraryId: heavy.library.id });
    return rows.length === 15 && rows.every((file) => file.hasThumb) ? rows : false;
  }, 90000);
  assert.equal(JSON.parse(heavyFiles.find((file) => file.filename === 'large.stl').metadataJson).triangleCount, 100000);
  assert.equal(JSON.parse(heavyFiles.find((file) => file.filename === 'multipart.3mf').metadataJson).thumbSource, 'gl');
  check(`100000-triangle mesh, sustained mesh rendering, and multipart 3MF samples (${Date.now() - started} ms)`);
  await ipc('rebuildThumbCache', heavy.library.id);
  await ipc('cancelCacheRebuild', heavy.library.id);
  assert.equal((await ipc('getCacheStatus', heavy.library.id)).state, 'cancelled');
  await ipc('rebuildThumbCache', heavy.library.id);
  await waitFor('cache rebuild restarted after cancellation', async () => (await ipc('getCacheStatus', heavy.library.id))?.state === 'complete', 90000);
  check('heavy thumbnail rebuild cancels and restarts to completion');
  fs.writeFileSync(path.join(temp, 'app.png'), (await window.webContents.capturePage()).toPNG());
  assert.ok(BrowserWindow.getAllWindows().length > 1, 'hidden workers should be alive for the shutdown test');
  passed = true;
  if (process.platform === 'darwin') {
    // macOS intentionally keeps the app alive; activation must recreate the main window.
    window.close();
    app.emit('activate');
    await waitFor('macOS main window recreated', () => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes('index.html')));
    check('macOS activation recreates the main window');
    app.quit();
  } else {
    window.close(); // No app.quit(): this is the lifecycle regression assertion.
  }
}).catch(fail);
