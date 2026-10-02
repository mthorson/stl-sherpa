import { app } from 'electron';
import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface RegistryEntry {
  /** UUID matching the `library.id` row inside the shared DB. */
  id: string;
  /** Friendly label cached from the DB for offline display. */
  label: string;
  /** This machine's absolute path to the library root. */
  mountPath: string;
  /** Unix ms timestamp of last successful open. */
  lastSeen: number;
}

interface RegistryFile {
  version: 1;
  libraries: RegistryEntry[];
}

const REGISTRY_FILENAME = 'libraries.json';

function registryPath(): string {
  return join(app.getPath('userData'), REGISTRY_FILENAME);
}

function readFile(): RegistryFile {
  const path = registryPath();
  if (!existsSync(path)) {
    return { version: 1, libraries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.libraries)) {
      return parsed as RegistryFile;
    }
  } catch {
    // Treat corrupted registry as empty rather than crashing the app on startup.
  }
  return { version: 1, libraries: [] };
}

function writeFile(file: RegistryFile): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a corrupt file behind.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function listEntries(): RegistryEntry[] {
  return readFile().libraries;
}

export function findById(id: string): RegistryEntry | undefined {
  return readFile().libraries.find((e) => e.id === id);
}

export function upsertEntry(entry: RegistryEntry): void {
  const file = readFile();
  const idx = file.libraries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) file.libraries[idx] = entry;
  else file.libraries.push(entry);
  writeFile(file);
}

export function removeEntry(id: string): void {
  const file = readFile();
  file.libraries = file.libraries.filter((e) => e.id !== id);
  writeFile(file);
}

export function touchLastSeen(id: string): void {
  const file = readFile();
  const entry = file.libraries.find((e) => e.id === id);
  if (!entry) return;
  entry.lastSeen = Date.now();
  writeFile(file);
}
