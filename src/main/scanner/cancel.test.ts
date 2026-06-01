import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canRun, freshDb } from '../db/test-utils';
import { ScannerService } from './service';
import { createFilesRepo } from '../db/repos/files';
import type { ScanProgress } from '../../shared/types';

describe.runIf(canRun)('ScannerService cancellation', () => {
  let root: string;

  beforeEach(() => {
    // A small synthetic library: a handful of .stl files in a subfolder.
    root = mkdtempSync(join(tmpdir(), 'meshflask-cancel-'));
    const sub = join(root, 'parts');
    mkdirSync(sub);
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(sub, `part-${i}.stl`), `solid p${i}\nendsolid p${i}\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cancelling a scan leaves the DB untouched and ends in cancelled state', async () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'lib-cancel');
    expect(files.count()).toBe(0);

    const scanner = new ScannerService();
    const cancelled = new Promise<ScanProgress>((resolveProgress) => {
      scanner.on('scan-cancelled', (_id, progress) => resolveProgress(progress));
    });

    // attach() kicks off the scan; it is now mid-walk (awaiting readdir).
    scanner.attach('lib-cancel', db, root);
    expect(scanner.getProgress('lib-cancel')?.state).toBe('scanning');

    // Cancel before the walk can finish. The diff is only applied after the
    // walk resolves, so an abort guarantees no rows were written.
    scanner.cancelScan('lib-cancel');

    const progress = await cancelled;
    expect(progress.state).toBe('cancelled');
    // Nothing was inserted/updated/removed — partial state is consistent.
    expect(files.count()).toBe(0);
    expect(progress.inserted).toBe(0);
    expect(progress.updated).toBe(0);
    expect(progress.removed).toBe(0);
    expect(scanner.getProgress('lib-cancel')?.state).toBe('cancelled');

    scanner.detach('lib-cancel');
    db.close();
  });
});
