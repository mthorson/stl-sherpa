import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canRun, freshDb } from '@main/db/test-utils';
import { createFilesRepo } from '@main/db/repos/files';
vi.mock('@main/preferences/store', () => ({ getAll: () => ({}) }));
import { ScannerService } from './service';

describe.runIf(canRun)('library availability recovery', () => {
  it('retains indexed files through a missing-root scan and reconnects with annotations intact', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'meshflask-recovery-'));
    const root = join(temp, 'mounted');
    mkdirSync(root);
    writeFileSync(join(root, 'model.stl'), 'solid test\nendsolid test\n');
    const db = freshDb();
    const files = createFilesRepo(db, 'lib');
    const scanner = new ScannerService();
    try {
      scanner.attach('lib', db, root);
      await vi.waitFor(() => expect(files.getByRelPath('model.stl')?.contentSha256).toBeTruthy());
      const original = files.getByRelPath('model.stl')!;
      files.setNotes(original.id, 'Retain on reconnect');
      renameSync(root, join(temp, 'disconnected'));
      expect((await scanner.rescan('lib')).ok).toBe(true);
      await vi.waitFor(() => expect(scanner.getProgress('lib')?.state).toBe('error'));
      expect(files.count()).toBe(1);
      expect(files.getById(original.id)?.notes).toBe('Retain on reconnect');
      renameSync(join(temp, 'disconnected'), root);
      expect((await scanner.rescan('lib')).ok).toBe(true);
      await vi.waitFor(() => expect(scanner.getProgress('lib')?.state).toBe('watching'));
      expect(files.getByRelPath('model.stl')?.id).toBe(original.id);
      expect(files.getById(original.id)?.notes).toBe('Retain on reconnect');
    } finally {
      await scanner.detachAll();
      db.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
