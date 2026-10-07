import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { v4 as uuid } from 'uuid';
import {
  emptyPreferences,
  isLogLevel,
  normalizeExtension,
  type ExternalAppRegistration,
  type ExternalAppSettingsPatch,
  type PreferencesFile,
  type PreferencesPatch
} from '@shared/preferences';
import { isRenderQuality } from '@shared/render-quality';
import { DEFAULT_PRINT_COST_PREFS, type PrintCostPreferences } from '@shared/print-cost';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('preferences');

const PREFERENCES_FILENAME = 'preferences.json';

function preferencesPath(): string {
  return join(app.getPath('userData'), PREFERENCES_FILENAME);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeProfiles(value: unknown): ExternalAppRegistration['profiles'] {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (profile): profile is { id: string; name: string; path: string } =>
        profile != null &&
        typeof profile === 'object' &&
        typeof profile.id === 'string' &&
        typeof profile.name === 'string' &&
        typeof profile.path === 'string'
    )
    .map((profile) => ({ ...profile, name: profile.name.trim() }))
    .filter((profile) => profile.id.length > 0 && profile.name.length > 0 && profile.path.length > 0);
}

function normalizeExternalApps(value: unknown): ExternalAppRegistration[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> => entry != null && typeof entry === 'object'
    )
    .flatMap((entry) => {
      if (
        typeof entry.id !== 'string' ||
        typeof entry.name !== 'string' ||
        typeof entry.path !== 'string' ||
        !Array.isArray(entry.extensions)
      ) {
        return [];
      }
      const extensions = entry.extensions
        .filter((ext): ext is string => typeof ext === 'string')
        .map(normalizeExtension)
        .filter(Boolean);
      const profiles = normalizeProfiles(entry.profiles);
      return [{
        id: entry.id,
        name: entry.name.trim(),
        path: entry.path,
        extensions,
        isDefault: entry.isDefault === true,
        ...(typeof entry.argsTemplate === 'string' && entry.argsTemplate.trim() !== ''
          ? { argsTemplate: entry.argsTemplate }
          : {}),
        ...(profiles != null ? { profiles } : {})
      }];
    })
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0 && entry.path.length > 0);
}

function normalizePrintCost(value: unknown): PrintCostPreferences | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PrintCostPreferences>;
  return {
    filament: {
      pricePerPackageUsd: nonNegativeNumber(
        candidate.filament?.pricePerPackageUsd,
        DEFAULT_PRINT_COST_PREFS.filament.pricePerPackageUsd
      ),
      kgsPerPackage: positiveNumber(
        candidate.filament?.kgsPerPackage,
        DEFAULT_PRINT_COST_PREFS.filament.kgsPerPackage
      )
    },
    resin: {
      pricePerPackageUsd: nonNegativeNumber(
        candidate.resin?.pricePerPackageUsd,
        DEFAULT_PRINT_COST_PREFS.resin.pricePerPackageUsd
      ),
      kgsPerPackage: positiveNumber(
        candidate.resin?.kgsPerPackage,
        DEFAULT_PRINT_COST_PREFS.resin.kgsPerPackage
      )
    },
    filamentFillFactor:
      typeof candidate.filamentFillFactor === 'number' &&
      Number.isFinite(candidate.filamentFillFactor)
        ? Math.min(1, Math.max(0.05, candidate.filamentFillFactor))
        : DEFAULT_PRINT_COST_PREFS.filamentFillFactor
  };
}

function normalizePreferences(value: unknown): PreferencesFile | null {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const printBeds = Array.isArray(candidate.printBeds)
    ? candidate.printBeds.filter(
        (bed): bed is { id: string; name: string; x: number; y: number; z: number } =>
          bed != null &&
          typeof bed === 'object' &&
          typeof bed.id === 'string' &&
          typeof bed.name === 'string' &&
          typeof bed.x === 'number' && Number.isFinite(bed.x) && bed.x > 0 &&
          typeof bed.y === 'number' && Number.isFinite(bed.y) && bed.y > 0 &&
          typeof bed.z === 'number' && Number.isFinite(bed.z) && bed.z > 0
      )
    : undefined;
  const pollInterval =
    typeof candidate.nasPollIntervalSec === 'number' && Number.isFinite(candidate.nasPollIntervalSec)
      ? Math.min(60, Math.max(1, candidate.nasPollIntervalSec))
      : undefined;
  const printCost = normalizePrintCost(candidate.printCost);

  return {
    version: 1,
    externalApps: normalizeExternalApps(candidate.externalApps),
    ...(candidate.unit === 'mm' || candidate.unit === 'in' ? { unit: candidate.unit } : {}),
    ...(printBeds ? { printBeds } : {}),
    ...(pollInterval != null ? { nasPollIntervalSec: pollInterval } : {}),
    ...(isRenderQuality(candidate.renderQuality) ? { renderQuality: candidate.renderQuality } : {}),
    ...(printCost ? { printCost } : {}),
    ...(isLogLevel(candidate.logLevel) ? { logLevel: candidate.logLevel } : {})
  };
}

function read(): PreferencesFile {
  const path = preferencesPath();
  if (!existsSync(path)) return emptyPreferences();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const normalized = normalizePreferences(parsed);
    if (normalized) {
      return normalized;
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
  // Write-then-rename so a crash mid-write can't leave a corrupt file behind.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function getAll(): PreferencesFile {
  return read();
}

export function patch(patch: PreferencesPatch): PreferencesFile {
  const current = read();
  const input = patch as Record<string, unknown>;
  const editable = [
    'unit',
    'printBeds',
    'nasPollIntervalSec',
    'renderQuality',
    'printCost',
    'logLevel'
  ] as const;
  const merged: Record<string, unknown> = { ...current };
  for (const key of editable) {
    if (Object.prototype.hasOwnProperty.call(input, key)) merged[key] = input[key];
  }
  const next = normalizePreferences({ ...merged, version: 1 }) ?? emptyPreferences();
  write(next);
  return next;
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

export function updateExternalApp(id: string, patch: ExternalAppSettingsPatch): boolean {
  const file = read();
  const app = file.externalApps.find((entry) => entry.id === id);
  if (!app) return false;
  if ('argsTemplate' in patch) {
    const value = typeof patch.argsTemplate === 'string' ? patch.argsTemplate.trim() : '';
    if (value) app.argsTemplate = value;
    else delete app.argsTemplate;
  }
  if ('profiles' in patch) {
    app.profiles = normalizeProfiles(patch.profiles) ?? [];
  }
  write(file);
  return true;
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
