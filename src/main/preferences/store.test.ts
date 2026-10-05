import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => mockState.userData }
}));
vi.mock('@main/logger', () => ({
  scopedLogger: () => ({ warn: () => undefined })
}));

import * as store from './store';

describe('preferences store', () => {
  beforeEach(() => {
    mockState.userData = mkdtempSync(join(tmpdir(), 'stl-sherpa-prefs-'));
  });

  afterEach(() => {
    rmSync(mockState.userData, { recursive: true, force: true });
  });

  it('persists every supported logging threshold, including off', () => {
    for (const logLevel of ['off', 'error', 'warn', 'info', 'debug'] as const) {
      store.patch({ logLevel });
      expect(store.getAll().logLevel).toBe(logLevel);
    }
  });

  it('normalizes hand-edited values before they reach runtime services', () => {
    mkdirSync(mockState.userData, { recursive: true });
    writeFileSync(
      join(mockState.userData, 'preferences.json'),
      JSON.stringify({
        version: 1,
        externalApps: [],
        unit: 'yards',
        nasPollIntervalSec: -50,
        renderQuality: 'cinematic',
        logLevel: 'trace',
        printBeds: [
          { id: 'good', name: 'Good', x: 220, y: 220, z: 250 },
          { id: 'bad', name: 'Bad', x: -1, y: 220, z: 250 }
        ]
      }),
      'utf8'
    );

    expect(store.getAll()).toEqual({
      version: 1,
      externalApps: [],
      nasPollIntervalSec: 1,
      printBeds: [{ id: 'good', name: 'Good', x: 220, y: 220, z: 250 }]
    });
  });

  it('updates only editable external-app settings', () => {
    const app = store.addExternalApp({
      name: 'Slicer',
      path: '/Applications/Slicer.app',
      extensions: ['.STL']
    });

    expect(
      store.updateExternalApp(app.id, {
        argsTemplate: '  --load {profile} {file}  ',
        profiles: [{ id: 'profile-1', name: ' Fast ', path: '/profiles/fast.ini' }]
      })
    ).toBe(true);
    expect(store.findExternalApp(app.id)).toMatchObject({
      name: 'Slicer',
      path: '/Applications/Slicer.app',
      extensions: ['stl'],
      argsTemplate: '--load {profile} {file}',
      profiles: [{ id: 'profile-1', name: 'Fast', path: '/profiles/fast.ini' }]
    });

    const persisted = JSON.parse(
      readFileSync(join(mockState.userData, 'preferences.json'), 'utf8')
    );
    expect(persisted.externalApps).toHaveLength(1);
  });

  it('merges independent preference patches onto the latest saved state', () => {
    const app = store.addExternalApp({
      name: 'Slicer',
      path: '/Applications/Slicer.app',
      extensions: ['stl']
    });
    store.patch({ unit: 'in' });
    store.patch({ nasPollIntervalSec: 20 });
    store.patch({ externalApps: [] } as never);

    expect(store.getAll()).toMatchObject({
      unit: 'in',
      nasPollIntervalSec: 20,
      externalApps: [{ id: app.id }]
    });
  });
});
