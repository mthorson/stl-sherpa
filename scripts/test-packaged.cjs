// Drive an installed app or Linux AppImage over a loopback-only DevTools connection.
// No test hooks or alternate entry point are included in the packaged app.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { writeSamples } = require('./sample-models.cjs');
const { killProcessGroup } = require('./process-group.cjs');

const executable = path.resolve(process.argv[2] || process.env.STL_SHERPA_EXECUTABLE || `release/stl-sherpa-${require('../package.json').version}.AppImage`);
if (!fs.existsSync(executable)) throw new Error(`Build the AppImage first: ${executable}`);
const upgradeFrom = process.env.STL_SHERPA_UPGRADE_FROM && path.resolve(process.env.STL_SHERPA_UPGRADE_FROM);
const output = path.resolve(process.env.STL_SHERPA_SMOKE_OUTPUT || 'test-results/packaged');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, 'run-'));
const config = path.join(root, 'config');
const profile = path.join(config, 'meshFlask');
const models = path.join(root, 'models');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ version: 1, externalApps: [], logLevel: 'debug' }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let child;
let connection;
let exit;
const deadline = setTimeout(() => { killProcessGroup(child); console.error('Packaged test exceeded 3 minutes'); process.exit(1); }, 180000);
// Software-rendered startup on hosted CPUs can stall the renderer for more
// than 15 seconds. Keep a finite command budget within the overall watchdog.
const commandTimeout = process.env.STL_SHERPA_SOFTWARE_RENDERING === '1' ? 45000 : 15000;
async function waitFor(label, fn, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw new Error(`App exited during ${label}: ${child.exitCode}`);
    const result = await fn();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function check(label) { results.push(label); console.log(`PACKAGED PASS: ${label}`); }
async function start(launchExecutable = executable) {
  const legacy = launchExecutable === upgradeFrom;
  const bridge = legacy ? "meshFlask" : "stlSherpa";
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(root, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const args = [ `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  if (launchExecutable.endsWith('.AppImage')) args.unshift('--appimage-extract-and-run');
  // Linux exercises the real legacy XDG profile location. Other platforms use
  // Chromium's explicit profile switch to avoid the runner's actual app data.
  if (process.platform !== 'linux') args.push(`--user-data-dir=${profile}`);
  if (env.STL_SHERPA_SOFTWARE_RENDERING === '1') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  child = spawn(launchExecutable, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (bytes) => fs.appendFileSync(path.join(root, 'process.log'), bytes));
  child.stderr.on('data', (bytes) => fs.appendFileSync(path.join(root, 'process.log'), bytes));
  exit = new Promise((resolve, reject) => { child.once('exit', (code) => resolve(code)); child.once('error', reject); });
  const target = await waitFor('packaged renderer', async () => {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((item) => item.type === 'page' && item.url.includes('/renderer/index.html'));
    } catch { return false; }
  });
  connection = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { connection.addEventListener('open', resolve, { once: true }); connection.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  connection.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    if (response.id) {
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      clearTimeout(request.timer);
      response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
    }
  });
  connection.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Renderer closed')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const operation = params.expression ? `${method}: ${params.expression.slice(0, 160)}` : method;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${operation}`)); }, commandTimeout);
    pending.set(id, { resolve, reject, timer });
    connection.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await waitFor('preload', () => evaluate(`typeof window.${bridge} === "object"`));
  assert.equal(await evaluate('document.title'), legacy ? 'meshFlask' : 'stl-sherpa');
  if (!legacy) assert.equal(await evaluate("document.body.innerText.includes('meshFlask')"), false);
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  assert.ok(fs.existsSync(path.join(profile, 'logs', 'main.log')), 'App must use the isolated XDG profile');
  return { send, evaluate, bridge, ipc: (method, ...args) => evaluate(`window.${bridge}[${JSON.stringify(method)}](...${JSON.stringify(args)})`) };
}
async function close(api) {
  void api.evaluate('window.close()').catch(() => {});
  if (process.platform === 'darwin') {
    // Closing the last window intentionally keeps macOS applications alive.
    await delay(500);
    killProcessGroup(child, 'SIGTERM');
  }
  const code = await Promise.race([exit, delay(15000).then(() => { throw new Error('Packaged app did not quit after main window closed'); })]);
  if (process.platform !== 'darwin') assert.equal(code, 0);
  connection.close();
  child = null;
}

(async () => {
  const png = await require('sharp')({ create: { width: 64, height: 64, channels: 4, background: '#ed7542' } }).png().toBuffer();
  writeSamples(models, png);
  let api = await start(upgradeFrom || executable);
  assert.equal((await api.ipc('getPreferences')).logLevel, 'debug', 'Existing meshFlask profile must be retained');
  check('packaged app launches with isolated profile and sandboxed renderer');
  const added = await api.ipc('addLibrary', { mountPath: models });
  assert.equal(added.ok, true, added.error);
  const libraryId = added.library.id;
  const files = await waitFor('packaged thumbnail workers', async () => {
    const rows = await api.ipc('queryFiles', { libraryId });
    return rows.length === 11 && rows.every((file) => file.hasThumb || file.thumbError) ? rows : false;
  });
  assert.equal(files.filter((file) => file.hasThumb).length, 10);
  check('packaged SQLite and workers index/render all six formats; malformed STL fails');
  const file = files.find((item) => item.ext === 'gltf');
  await api.ipc('setFileNotes', libraryId, file.id, 'Persisted by packaged acceptance');
  const savedTag = await api.ipc('addTagToFile', libraryId, file.id, 'release/keep');
  await api.ipc('setFileRatings', libraryId, [file.id], 4);
  await api.ipc('setFileColorLabels', libraryId, [file.id], 'green');
  const customThumb = await require('sharp')({ create: { width: 96, height: 96, channels: 4, background: '#466cbd' } }).png().toBuffer();
  await api.evaluate(`window.${api.bridge}.saveCustomThumbnail(${JSON.stringify(libraryId)}, ${file.id}, new Uint8Array(${JSON.stringify([...customThumb])}))`);
  const thumbnailFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? thumbnailFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const savedThumbnail = thumbnailFiles(path.join(models, '.meshFlask', 'thumbs')).find(name => fs.readFileSync(name).equals(customThumb));
  assert.ok(savedThumbnail, 'Custom thumbnail was written');
  await api.ipc('patchPreferences', { logLevel: 'warn' });
  await api.evaluate("localStorage.setItem('rename-acceptance', 'saved-ui-state')");
  await close(api);
  check(process.platform === 'darwin' ? 'packaged macOS test session closes' : 'main-window close shuts down the packaged app and workers');
  api = await start();
  assert.ok((await api.ipc('listLibraries')).some((library) => library.id === libraryId));
  assert.equal((await api.ipc('queryFiles', { libraryId })).find((row) => row.id === file.id).notes, 'Persisted by packaged acceptance');
  const retained = (await api.ipc('queryFiles', { libraryId })).find(row => row.id === file.id);
  assert.equal(retained.rating, 4);
  assert.equal(retained.colorLabel, 'green');
  assert.ok((await api.ipc('listTagsForFile', libraryId, file.id)).some(tag => tag.id === savedTag.id && tag.name === savedTag.name));
  assert.deepEqual(fs.readFileSync(savedThumbnail), customThumb);
  assert.equal((await api.ipc('getPreferences')).logLevel, 'warn');
  assert.equal(await api.evaluate("localStorage.getItem('rename-acceptance')"), 'saved-ui-state');
  check(`library IDs, tags, notes, ratings, custom thumbnails, preferences, and UI state survive ${upgradeFrom ? 'the meshFlask upgrade' : 'restart'}`);
  await api.ipc('patchPreferences', { logLevel: 'debug' });
  const logPath = path.join(profile, 'logs', 'main.log');
  const offset = fs.statSync(logPath).size;
  await waitFor('glTF tile', () => api.evaluate(`(() => { const tile = [...document.querySelectorAll('[title]')].find(el => el.title === 'external.gltf'); if (!tile) return false; tile.click(); return true; })()`));
  await waitFor('packaged glTF live preview', () => fs.readFileSync(logPath, 'utf8').slice(offset).includes('model loaded'));
  assert.equal(await api.evaluate("document.body.innerText.includes('Preview failed')"), false);
  const screenshot = await api.send('Page.captureScreenshot');
  fs.writeFileSync(path.join(root, 'app.png'), Buffer.from(screenshot.data, 'base64'));
  check('packaged live glTF preview loads external buffer and texture');
  if (process.env.STL_SHERPA_SHOWCASE) await require('./capture-showcase.cjs')(api, root, libraryId, waitFor);
  await close(api);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, executable, results }, null, 2));
  console.log(`PACKAGED COMPLETE: ${root}`);
})().catch(async (error) => {
  console.error(error);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, results, error: String(error) }, null, 2));
  connection?.close();
  killProcessGroup(child);
  if (child) await Promise.race([exit.catch(() => {}), delay(5000)]);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
