import { describe, expect, it } from 'vitest';
import { canRun, freshDb } from '../test-utils';
import { createFilesRepo } from './files';

describe.runIf(canRun)('orientation: default per format + user override', () => {
  it('STL and 3MF default to +Z up; GLB defaults to +Y up', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsertMany([
      { relPath: 'a.stl', parentDir: '', filename: 'a.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 },
      { relPath: 'b.3mf', parentDir: '', filename: 'b.3mf', ext: '3mf', sizeBytes: 1, mtimeMs: 2 },
      { relPath: 'c.glb', parentDir: '', filename: 'c.glb', ext: 'glb', sizeBytes: 1, mtimeMs: 3 }
    ]);
    const a = files.getByRelPath('a.stl')!;
    const b = files.getByRelPath('b.3mf')!;
    const c = files.getByRelPath('c.glb')!;
    expect(a.orientation.upAxis).toBe('+Z');
    expect(a.orientationCustomized).toBe(false);
    expect(b.orientation.upAxis).toBe('+Z');
    expect(c.orientation.upAxis).toBe('+Y');
    db.close();
  });

  it('setOrientation persists override; clear restores format default', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.stl')!.id;

    files.setOrientation(id, { upAxis: '-Y' });
    const after = files.getByRelPath('a.stl')!;
    expect(after.orientation.upAxis).toBe('-Y');
    expect(after.orientationCustomized).toBe(true);

    files.setOrientation(id, null);
    const reset = files.getByRelPath('a.stl')!;
    expect(reset.orientation.upAxis).toBe('+Z'); // format default
    expect(reset.orientationCustomized).toBe(false);
    db.close();
  });

  it('round-trips yaw alongside upAxis', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsert({
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    });
    const id = files.getByRelPath('a.stl')!.id;

    files.setOrientation(id, { upAxis: '+Z', yaw: 90 });
    const after = files.getByRelPath('a.stl')!;
    expect(after.orientation.upAxis).toBe('+Z');
    expect(after.orientation.yaw).toBe(90);
    expect(after.orientationCustomized).toBe(true);
    db.close();
  });

  it('listInFolder includes the effective orientation', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'test-library');
    files.upsertMany([
      { relPath: 'x.stl', parentDir: 'sub', filename: 'x.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1 },
      { relPath: 'y.glb', parentDir: 'sub', filename: 'y.glb', ext: 'glb', sizeBytes: 1, mtimeMs: 2 }
    ]);
    files.setOrientation(files.getByRelPath('y.glb')!.id, { upAxis: '+Z' });
    const list = files.listInFolder('sub');
    const x = list.find((f) => f.filename === 'x.stl')!;
    const y = list.find((f) => f.filename === 'y.glb')!;
    expect(x.orientation.upAxis).toBe('+Z'); // default for stl
    expect(x.orientationCustomized).toBe(false);
    expect(y.orientation.upAxis).toBe('+Z'); // user override
    expect(y.orientationCustomized).toBe(true);
    db.close();
  });
});
