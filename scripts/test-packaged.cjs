// Drive the actual Linux AppImage over a loopback-only DevTools connection.
// No test hooks or alternate entry point are included in the packaged app.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { writeSamples } = require('./sample-models.cjs');

if (process.platform !== 'linux') throw new Error('This acceptance test targets the Linux AppImage');
const executable = path.resolve(process.argv[2] || `release/stl-sherpa-${require('../package.json').version}.AppImage`);
if (!fs.existsSync(executable)) throw new Error(`Build the AppImage first: ${executable}`);
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
const deadline = setTimeout(() => { child?.kill('SIGKILL'); console.error('Packaged test exceeded 3 minutes'); process.exit(1); }, 180000);
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
async function start() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(root, 'cache') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const args = ['--appimage-extract-and-run', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  if (env.STL_SHERPA_SOFTWARE_RENDERING === '1') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    connection.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await waitFor('preload', () => evaluate('typeof window.stlSherpa === "object"'));
  assert.equal(await evaluate('document.title'), 'stl-sherpa');
  assert.equal(await evaluate("document.body.innerText.includes('meshFlask')"), false);
  assert.equal(await evaluate('typeof window.require'), 'undefined');
  assert.ok(fs.existsSync(path.join(profile, 'logs', 'main.log')), 'App must use the isolated XDG profile');
  return { send, evaluate, ipc: (method, ...args) => evaluate(`window.stlSherpa[${JSON.stringify(method)}](...${JSON.stringify(args)})`) };
}
async function close(api) {
  void api.evaluate('window.close()').catch(() => {});
  const code = await Promise.race([exit, delay(15000).then(() => { throw new Error('Packaged app did not quit after main window closed'); })]);
  assert.equal(code, 0);
  connection.close();
  child = null;
}

(async () => {
  const png = await require('sharp')({ create: { width: 64, height: 64, channels: 4, background: '#ed7542' } }).png().toBuffer();
  writeSamples(models, png);
  let api = await start();
  assert.equal((await api.ipc('getPreferences')).logLevel, 'debug', 'Existing meshFlask profile must be retained');
  check('AppImage launches with isolated profile and sandboxed renderer');
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
  await api.ipc('patchPreferences', { logLevel: 'warn' });
  await api.evaluate("localStorage.setItem('rename-acceptance', 'saved-ui-state')");
  await close(api);
  check('main-window close shuts down the packaged app and workers');
  api = await start();
  assert.ok((await api.ipc('listLibraries')).some((library) => library.id === libraryId));
  assert.equal((await api.ipc('queryFiles', { libraryId })).find((row) => row.id === file.id).notes, 'Persisted by packaged acceptance');
  assert.equal((await api.ipc('getPreferences')).logLevel, 'warn');
  assert.equal(await api.evaluate("localStorage.getItem('rename-acceptance')"), 'saved-ui-state');
  check('library, annotations, and preferences survive a packaged-app restart');
  await api.ipc('patchPreferences', { logLevel: 'debug' });
  const logPath = path.join(profile, 'logs', 'main.log');
  const offset = fs.statSync(logPath).size;
  await waitFor('glTF tile', () => api.evaluate(`(() => { const tile = [...document.querySelectorAll('[title]')].find(el => el.title === 'external.gltf'); if (!tile) return false; tile.click(); return true; })()`));
  await waitFor('packaged glTF live preview', () => fs.readFileSync(logPath, 'utf8').slice(offset).includes('model loaded'));
  assert.equal(await api.evaluate("document.body.innerText.includes('Preview failed')"), false);
  const screenshot = await api.send('Page.captureScreenshot');
  fs.writeFileSync(path.join(root, 'app.png'), Buffer.from(screenshot.data, 'base64'));
  check('packaged live glTF preview loads external buffer and texture');
  await close(api);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: true, executable, results }, null, 2));
  console.log(`PACKAGED COMPLETE: ${root}`);
})().catch(async (error) => {
  console.error(error);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: false, results, error: String(error) }, null, 2));
  connection?.close();
  child?.kill('SIGTERM');
  if (child) await Promise.race([exit, delay(5000).then(() => child?.kill('SIGKILL'))]);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
