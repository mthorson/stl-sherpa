import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The manager pulls in the scanner, events, and logger, which reach for
// Electron APIs that don't exist under vitest. Mock the seams: a minimal
// `app.getPath` (registry + prefs live under userData) and no-op loggers /
// broadcasts. Everything else — SQLite, the registry JSON, the filesystem —
// is real, so this exercises the actual relocate path end to end.
vi.mock('electron', async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs');
  const { tmpdir: osTmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const userData = mkdtemp(pjoin(osTmpdir(), 'meshflask-userdata-'));
  return {
    app: { getPath: () => userData },
    BrowserWindow: { getAllWindows: () => [] }
  };
});
vi.mock('@main/logger', () => {
  const noop = () => undefined;
  const scoped = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    scopedLogger: () => scoped,
    time: <T>(_l: unknown, _n: string, fn: () => T) => fn()
  };
});
vi.mock('@main/events', () => ({
  broadcastLibraryEvent: () => undefined,
  broadcastOrQueue: () => undefined,
  deliverPendingOnReady: () => undefined
}));

import * as manager from './manager';
import * as registry from './registry';

function makeLibraryDir(): string {
  return mkdtempSync(join(tmpdir(), 'meshflask-lib-'));
}

describe('manager.relocateLibrary', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await manager.shutdown();
    for (const id of registry.listEntries().map((e) => e.id)) registry.removeEntry(id);
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function addLibraryAt(dir: string, name: string) {
    cleanupDirs.push(dir);
    const added = await manager.addLibrary({ mountPath: dir, name });
    if (!added.ok) throw new Error(added.error);
    return added.library;
  }

  it('re-points a moved library and reattaches it', async () => {
    const oldDir = makeLibraryDir();
    const lib = await addLibraryAt(oldDir, 'Minis');

    // Simulate the user moving/renaming the folder while the app is closed.
    await manager.shutdown();
    const newDir = `${oldDir}-moved`;
    cleanupDirs.push(newDir);
    renameSync(oldDir, newDir);

    const result = await manager.relocateLibrary({ id: lib.id, newMountPath: newDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.library.mountPath).toBe(newDir);
    expect(result.library.online).toBe(true);
    // Registry persisted the new path.
    expect(registry.findById(lib.id)?.mountPath).toBe(newDir);
    // Same identity: the DB row still carries the original UUID.
    const raw = readFileSync(join(newDir, '.meshFlask.db'));
    expect(raw.length).toBeGreaterThan(0);
    expect(manager.getOpenLibrary(lib.id)).toBeDefined();
  });

  it('rejects a folder that is not a meshFlask library', async () => {
    const dir = makeLibraryDir();
    const lib = await addLibraryAt(dir, 'Minis');
    const empty = makeLibraryDir();
    cleanupDirs.push(empty);

    const result = await manager.relocateLibrary({ id: lib.id, newMountPath: empty });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(".meshFlask.db");
    // Original mapping untouched.
    expect(registry.findById(lib.id)?.mountPath).toBe(dir);
  });

  it('rejects a folder that holds a different library', async () => {
    const dirA = makeLibraryDir();
    const libA = await addLibraryAt(dirA, 'Minis');
    const dirB = makeLibraryDir();
    await addLibraryAt(dirB, 'Terrain');

    const result = await manager.relocateLibrary({ id: libA.id, newMountPath: dirB });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Terrain');
    expect(registry.findById(libA.id)?.mountPath).toBe(dirA);
    // Inspecting a rejected candidate must not create backups or run
    // migrations against that other library.
    expect(existsSync(join(dirB, '.meshFlask/backups'))).toBe(false);
  });

  it('rejects a missing folder', async () => {
    const dir = makeLibraryDir();
    const lib = await addLibraryAt(dir, 'Minis');
    const gone = join(tmpdir(), 'meshflask-definitely-missing');
    expect(existsSync(gone)).toBe(false);

    const result = await manager.relocateLibrary({ id: lib.id, newMountPath: gone });
    expect(result.ok).toBe(false);
  });

  it('relocating an online library drops the old handle first', async () => {
    const oldDir = makeLibraryDir();
    const lib = await addLibraryAt(oldDir, 'Minis');
    expect(manager.getOpenLibrary(lib.id)).toBeDefined();

    // Move the whole folder (as a user would) while the old handle is still
    // open — the WAL sidecars travel with the directory.
    const newDir = `${oldDir}-moved`;
    cleanupDirs.push(newDir);
    renameSync(oldDir, newDir);

    const result = await manager.relocateLibrary({ id: lib.id, newMountPath: newDir });
    expect(result.ok).toBe(true);
    expect(manager.getOpenLibrary(lib.id)?.entry.mountPath).toBe(newDir);
  });
});
