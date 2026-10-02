import { execFileSync } from 'node:child_process';
import { looksLikeNetworkMount } from '@shared/paths';
import { scopedLogger } from '@main/logger';

const log = scopedLogger('network-mount');

/**
 * OS-aware "is this path on a network filesystem?" check for the main
 * process. The shared `looksLikeNetworkMount` heuristic covers UNC paths and
 * conventional POSIX mount points, but it cannot see that `Z:\` is an SMB
 * share mapped to a drive letter — and opening a library DB in WAL mode over
 * SMB is exactly the corruption case the journal-mode fallback exists for.
 * On Windows we ask the OS via `fsutil fsinfo drivetype`; everywhere else
 * (and whenever fsutil fails) we fall back to the heuristic.
 */

const WIN_DRIVE_RE = /^([a-zA-Z]):[\\/]/;

/** Cached per drive letter — drive mappings don't change mid-session. */
const driveTypeCache = new Map<string, boolean>();

/**
 * Parse `fsutil fsinfo drivetype X:` output into "is network drive".
 * Returns null when the output matches no known drive type (unexpected
 * locale or format), so callers can fall back to the heuristic.
 * Exported for tests.
 */
export function parseFsutilDriveType(output: string): boolean | null {
  if (/remote|network/i.test(output)) return true;
  if (/fixed|removable|cd-rom|ram\s*disk/i.test(output)) return false;
  return null;
}

export function isNetworkMount(absPath: string): boolean {
  if (process.platform === 'win32') {
    const m = WIN_DRIVE_RE.exec(absPath);
    if (m) {
      const letter = m[1].toUpperCase();
      const cached = driveTypeCache.get(letter);
      if (cached !== undefined) return cached;
      try {
        const out = execFileSync('fsutil', ['fsinfo', 'drivetype', `${letter}:`], {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true
        });
        const parsed = parseFsutilDriveType(out);
        if (parsed !== null) {
          driveTypeCache.set(letter, parsed);
          return parsed;
        }
        log.warn('unrecognized fsutil drivetype output', { letter, out: out.trim() });
      } catch (err) {
        log.warn('fsutil drivetype failed, using heuristic', {
          letter,
          err: (err as Error).message
        });
      }
    }
  }
  return looksLikeNetworkMount(absPath);
}
