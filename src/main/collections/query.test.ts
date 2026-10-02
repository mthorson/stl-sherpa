import { describe, expect, it } from 'vitest';
import { createCollectionsRepo } from '@main/db/repos/collections';
import { createFilesRepo } from '@main/db/repos/files';
import { canRun, freshDb } from '@main/db/test-utils';
import { DEFAULT_SORT } from '@shared/sort';
import { createCollectionQuery } from './query';

function setup() {
  const db = freshDb();
  const files = createFilesRepo(db, 'test-library');
  files.upsertMany([
    {
      relPath: 'a.stl',
      parentDir: '',
      filename: 'a.stl',
      ext: 'stl',
      sizeBytes: 1,
      mtimeMs: 1
    },
    {
      relPath: 'nested/b.stl',
      parentDir: 'nested',
      filename: 'b.stl',
      ext: 'stl',
      sizeBytes: 2,
      mtimeMs: 2
    },
    {
      relPath: 'c.obj',
      parentDir: '',
      filename: 'c.obj',
      ext: 'obj',
      sizeBytes: 3,
      mtimeMs: 3
    },
    {
      relPath: 'd.stl',
      parentDir: '',
      filename: 'd.stl',
      ext: 'stl',
      sizeBytes: 4,
      mtimeMs: 4
    }
  ]);
  const records = new Map(files.query({}).map((file) => [file.filename, file]));
  files.setRatings([records.get('a.stl')!.id], 5);
  files.setRatings([records.get('b.stl')!.id], 3);
  files.setRatings([records.get('c.obj')!.id], 4);
  files.setRatings([records.get('d.stl')!.id], 1);
  files.setColorLabels([records.get('a.stl')!.id, records.get('c.obj')!.id], 'red');
  files.setColorLabels([records.get('b.stl')!.id], 'blue');

  const collections = createCollectionsRepo(db);
  return {
    db,
    files,
    collections,
    records,
    query: createCollectionQuery(files, collections)
  };
}

describe.runIf(canRun)('CollectionQuery', () => {
  it('exports every page of large manual and smart collections with tied sort values', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'large');
    files.upsertMany(Array.from({ length: 10007 }, (_, i) => ({
      relPath: `${i}/same.stl`, parentDir: String(i), filename: 'same.stl', ext: 'stl', sizeBytes: 1, mtimeMs: 1
    })));
    const collections = createCollectionsRepo(db);
    const query = createCollectionQuery(files, collections);
    const all = query.queryAll({});
    expect(all).toHaveLength(10007);
    expect(new Set(all.map((file) => file.id)).size).toBe(10007);
    const manual = collections.create('All');
    const ids = all.map((file) => file.id).reverse();
    collections.addFiles(manual.id, ids);
    expect(query.queryAll({ collectionId: manual.id, sort: DEFAULT_SORT }).map((file) => file.id)).toEqual(ids);
    const smart = collections.createSmart('STL', { extensions: ['stl'] });
    expect(query.queryAll({ collectionId: smart.id }).map((file) => file.id)).toEqual(all.map((file) => file.id));
    db.close();
  });

  it('treats recursive directory scopes literally, including SQL wildcards and case', () => {
    const db = freshDb();
    const files = createFilesRepo(db, 'folders');
    const paths = ['part_1/a.stl', 'part_1/sub/b.stl', 'partX1/c.stl', 'Part_1/d.stl', '50%/e.stl', '500/f.stl'];
    files.upsertMany(paths.map((relPath) => ({ relPath, parentDir: relPath.slice(0, relPath.lastIndexOf('/')), filename: relPath.split('/').at(-1)!, ext: 'stl', sizeBytes: 1, mtimeMs: 1 })));
    expect(files.query({ parentDir: 'part_1', recursive: true }).map((file) => file.relPath)).toEqual(paths.slice(0, 2));
    expect(files.query({ parentDir: '50%', recursive: true }).map((file) => file.relPath)).toEqual(['50%/e.stl']);
    expect(files.query({ parentDir: '', recursive: true })).toHaveLength(6);
    db.close();
  });

  it('resolves a smart collection from its saved rules', () => {
    const { db, collections, query } = setup();
    const collection = collections.createSmart('Ready', {
      extensions: ['stl'],
      minRating: 3,
      colorLabels: ['red']
    });

    expect(
      query.query({ collectionId: collection.id }).map((file) => file.filename)
    ).toEqual(['a.stl']);
    db.close();
  });

  it('lets non-empty runtime filters replace the matching saved rules', () => {
    const { db, collections, query } = setup();
    const collection = collections.createSmart('Ready', {
      extensions: ['stl'],
      minRating: 3,
      colorLabels: ['red']
    });

    expect(
      query
        .query({ collectionId: collection.id, colorLabels: ['blue'] })
        .map((file) => file.filename)
    ).toEqual(['b.stl']);
    expect(
      query
        .query({ collectionId: collection.id, extensions: ['obj'] })
        .map((file) => file.filename)
    ).toEqual(['c.obj']);
    db.close();
  });

  it('uses the whole library for smart collection membership', () => {
    const { db, collections, query } = setup();
    const collection = collections.createSmart('Nested STL', { search: 'b' });

    expect(
      query
        .query({ collectionId: collection.id, parentDir: '', recursive: false })
        .map((file) => file.filename)
    ).toEqual(['b.stl']);
    db.close();
  });

  it('preserves manual collection position for the default view sort', () => {
    const { db, collections, records, query } = setup();
    const collection = collections.create('Queue');
    collections.addFiles(collection.id, [
      records.get('d.stl')!.id,
      records.get('a.stl')!.id
    ]);

    expect(
      query
        .query({ collectionId: collection.id, sort: DEFAULT_SORT })
        .map((file) => file.filename)
    ).toEqual(['d.stl', 'a.stl']);
    db.close();
  });

  it('honors an explicit non-default sort for a manual collection', () => {
    const { db, collections, records, query } = setup();
    const collection = collections.create('Queue');
    collections.addFiles(collection.id, [
      records.get('a.stl')!.id,
      records.get('d.stl')!.id
    ]);

    expect(
      query
        .query({
          collectionId: collection.id,
          sort: { field: 'size', direction: 'desc' }
        })
        .map((file) => file.filename)
    ).toEqual(['d.stl', 'a.stl']);
    db.close();
  });

  it('returns no files for an unknown collection', () => {
    const { db, query } = setup();
    expect(query.query({ collectionId: 999 })).toEqual([]);
    db.close();
  });
});
