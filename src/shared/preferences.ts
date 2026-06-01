/**
 * Per-machine preferences — not stored in the library DB because tool
 * paths are inherently machine-local. The PreferencesFile lives in
 * `app.getPath('userData')/preferences.json` next to `libraries.json`.
 */

export interface SlicerProfile {
  id: string;
  name: string;
  path: string;
}

export interface ExternalAppRegistration {
  /** UUID generated at registration time. */
  id: string;
  /** Display name shown in the "Open with…" menu. */
  name: string;
  /**
   * Absolute path to the app on this machine. On macOS this is typically a
   * `.app` bundle path; on Windows an `.exe`; on Linux any executable.
   */
  path: string;
  /** Lowercase extensions this app can handle. Empty array = applies to any. */
  extensions: string[];
  /**
   * When true, this app becomes the default for its extensions in the
   * Open-with submenu. Only one app per extension can be default; the
   * preferences store enforces this on write.
   */
  isDefault: boolean;
  /**
   * Optional CLI args template. Tokens: `{file}` (absolute path) and
   * `{profile}` (selected profile path or empty string). When unset we just
   * pass the file as a single arg. Example: `--load {profile} {file}`.
   */
  argsTemplate?: string;
  /** Named slicer profiles the user picks from on launch. */
  profiles?: SlicerProfile[];
}

export type Unit = 'mm' | 'in';

// Duplicated rather than imported from src/main/logger.ts so this shared
// module stays pure — main-only imports would break renderer typecheck and
// vitest (no Electron `app` in system Node).
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface PrintBed {
  id: string;
  name: string;
  /** mm */
  x: number;
  /** mm */
  y: number;
  /** mm */
  z: number;
}

export interface PreferencesFile {
  version: 1;
  externalApps: ExternalAppRegistration[];
  /** Display unit for dimensions. Default mm. */
  unit?: Unit;
  /** Registered printer bed sizes used by the print-bed-fit feature. */
  printBeds?: PrintBed[];
  /** Polling interval for chokidar on network mounts, seconds. Default 10. */
  nasPollIntervalSec?: number;
  /** Render quality tier for the interactive 3D preview (Low/Medium/High/Ultra).
   *  Background thumbnail rendering always uses Low for consistency. */
  renderQuality?: import('./render-quality').RenderQuality;
  /** Material costs for the print-cost estimate shown in the metadata panel.
   *  Falls back to DEFAULT_PRINT_COST_PREFS when absent. */
  printCost?: import('./print-cost').PrintCostPreferences;
  /** Verbosity for the main-process file log. Default 'info'. Changes apply
   *  immediately without a restart. */
  logLevel?: LogLevel;
}

export function emptyPreferences(): PreferencesFile {
  return { version: 1, externalApps: [] };
}

/** Normalize extensions for matching: trim, lowercase, strip leading dot. */
export function normalizeExtension(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e.startsWith('.') ? e.slice(1) : e;
}
