const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { killProcessGroup } = require('./process-group.cjs');

test('failure cleanup closes inherited pipes even after the AppImage wrapper exits', {
  skip: process.platform !== 'linux', timeout: 5000
}, async (t) => {
  const descendant = 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)';
  const wrapper = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', wrapper], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => killProcessGroup(child));
  const closed = once(child, 'close');
  const [ready] = await once(child.stdout, 'data');
  assert.match(ready.toString(), /ready/);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  assert.equal(child.stdout.destroyed, false, 'The descendant still holds the output pipe');
  killProcessGroup(child);
  await closed;
  assert.equal(child.stdout.destroyed, true);
});
