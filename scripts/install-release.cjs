// Install only into a disposable CI runner or explicit temporary test directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
if (process.env.CI !== 'true') throw new Error('Installer acceptance is restricted to disposable CI runners');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-sherpa-installed-'));
const version = require('../package.json').version;
const artifact = (extension) => {
  const matches = fs.readdirSync('release').filter(name => name.includes(version) && name.endsWith(extension));
  assert.equal(matches.length, 1, `Expected one native ${extension} installer, found ${matches}`);
  return path.resolve('release', matches[0]);
};
let executable;
if (process.platform === 'win32') {
  // NSIS requires /D to be the final argument, including when the path has spaces.
  run(artifact('.exe'), ['/S', `/D=${root}`]);
  executable = path.join(root, 'stl-sherpa.exe');
} else if (process.platform === 'darwin') {
  const mount = path.join(root, 'dmg');
  fs.mkdirSync(mount);
  run('hdiutil', ['attach', artifact('.dmg'), '-nobrowse', '-readonly', '-mountpoint', mount]);
  const app = path.join(root, 'stl-sherpa.app');
  try { run('ditto', [path.join(mount, 'stl-sherpa.app'), app]); }
  finally { run('hdiutil', ['detach', mount]); }
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run('xcrun', ['stapler', 'validate', app]);
  executable = path.join(app, 'Contents', 'MacOS', 'stl-sherpa');
} else {
  run('sudo', ['sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=1']);
  run('sudo', ['apt-get', 'install', '-y', artifact('.deb')]);
  assert.ok(fs.existsSync('/etc/apparmor.d/stl-sherpa'), 'The Debian installer must install its AppArmor profile');
  executable = '/opt/stl-sherpa/stl-sherpa';
}
assert.ok(fs.existsSync(executable), `Installed executable missing: ${executable}`);
fs.appendFileSync(process.env.GITHUB_ENV, `STL_SHERPA_EXECUTABLE=${executable}\n`);
console.log(`Installed ${executable}`);
