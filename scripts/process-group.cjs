// Acceptance tests must terminate Electron descendants as well as wrappers.
// On POSIX, spawn with detached: true so the PID is also the process group ID.
function killProcessGroup(child, signal = 'SIGKILL') {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null) {
      require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    return;
  }
  try {
    // The wrapper may already have exited while descendants still hold pipes.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

module.exports = { killProcessGroup };
