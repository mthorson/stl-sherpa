import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { v4 as uuid } from 'uuid';
import {
  emptyPreferences,
  normalizeExtension,
  type ExternalAppRegistration,
  type PreferencesFile
} from '@shared/preferences';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('preferences');

const PREFERENCES_FILENAME = 'preferences.json';

function preferencesPath(): string {
  return join(app.getPath('userData'), PREFERENCES_FILENAME);
}

function read(): PreferencesFile {
  const path = preferencesPath();
  if (!existsSync(path)) return emptyPreferences();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.externalApps)) {
      return parsed as PreferencesFile;
    }
    log.warn('preferences.json schema mismatch, falling back to defaults', {
      path,
      version: parsed?.version
    });
  } catch (err) {
    // Treat corrupted prefs as empty rather than crashing the app on startup.
    log.warn('preferences.json unreadable, falling back to defaults', {
      path,
      err: (err as Error).message
    });
  }
  return emptyPreferences();
}

function write(file: PreferencesFile): void {
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');
}

export function getAll(): PreferencesFile {
  return read();
}

/** Replace the whole prefs file in one shot — used by the settings UI. */
export function saveAll(prefs: PreferencesFile): void {
  // Preserve unknown fields by merging onto the read-back base; v1 only.
  const base = read();
  write({ ...base, ...prefs, version: 1 });
}

export function listExternalApps(): ExternalAppRegistration[] {
  return read().externalApps;
}

/** Apps registered for `ext`, with the default (if any) sorted to the front. */
export function listExternalAppsForExtension(ext: string): ExternalAppRegistration[] {
  const normalized = normalizeExtension(ext);
  const apps = read().externalApps.filter(
    (a) => a.extensions.length === 0 || a.extensions.includes(normalized)
  );
  apps.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return apps;
}

export function findExternalApp(id: string): ExternalAppRegistration | undefined {
  return read().externalApps.find((a) => a.id === id);
}

export function addExternalApp(args: {
  name: string;
  path: string;
  extensions: string[];
}): ExternalAppRegistration {
  const file = read();
  const reg: ExternalAppRegistration = {
    id: uuid(),
    name: args.name.trim(),
    path: args.path,
    extensions: args.extensions.map(normalizeExtension).filter((e) => e.length > 0),
    isDefault: false
  };
  file.externalApps.push(reg);
  write(file);
  return reg;
}

export function removeExternalApp(id: string): void {
  const file = read();
  file.externalApps = file.externalApps.filter((a) => a.id !== id);
  write(file);
}

/**
 * Mark `id` as the default for `ext`. Clears the default flag on any other
 * app that handles `ext` so there is exactly one default per extension.
 */
export function setDefaultExternalApp(id: string, ext: string): void {
  const normalized = normalizeExtension(ext);
  const file = read();
  for (const app of file.externalApps) {
    const handles = app.extensions.length === 0 || app.extensions.includes(normalized);
    if (handles) {
      app.isDefault = app.id === id;
    }
  }
  write(file);
}
