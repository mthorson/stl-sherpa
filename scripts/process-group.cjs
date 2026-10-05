// Linux acceptance tests launch AppImage wrappers that spawn Electron children.
// The child must be spawned with detached: true so its PID is also its group ID.
function killProcessGroup(child, signal = 'SIGKILL') {
  if (!child?.pid) return;
  try {
    // The wrapper may already have exited while descendants still hold pipes.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

module.exports = { killProcessGroup };
