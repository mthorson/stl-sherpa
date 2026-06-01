/**
 * PathResolver — the single chokepoint for converting between
 * machine-specific absolute paths and the POSIX-relative paths stored in
 * the shared library DB. All filesystem reads/writes that touch a file
 * tracked in a library MUST resolve through here so the DB stays portable
 * across macOS / Windows / NAS mount points.
 */

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WIN_UNC_RE = /^\\\\[^\\]+\\[^\\]+/;

export function isWindowsAbsolute(p: string): boolean {
  return WIN_DRIVE_RE.test(p) || WIN_UNC_RE.test(p);
}

export function isPosixAbsolute(p: string): boolean {
  return p.startsWith('/');
}

export function isAbsolute(p: string): boolean {
  return isPosixAbsolute(p) || isWindowsAbsolute(p);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function stripTrailingSeparators(p: string): string {
  if (p.length <= 1) return p;
  if (WIN_DRIVE_RE.test(p) && p.length === 3) return p;
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return p.slice(0, end);
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath) throw new Error('mountPath cannot be empty');
  return stripTrailingSeparators(mountPath);
}

export class PathResolver {
  private readonly mountPath: string;
  private readonly mountPosix: string;
  private readonly isWindowsMount: boolean;

  constructor(mountPath: string) {
    this.mountPath = normalizeMountPath(mountPath);
    this.mountPosix = toPosix(this.mountPath);
    this.isWindowsMount = isWindowsAbsolute(this.mountPath);
  }

  /**
   * Convert an absolute filesystem path under the library mount into a
   * POSIX-style path relative to the mount root. The result is what gets
   * stored in the DB.
   */
  toRelative(absPath: string): string {
    if (!isAbsolute(absPath)) {
      throw new Error(`toRelative requires an absolute path, got: ${absPath}`);
    }
    if (absPath.includes('\0')) {
      throw new Error('toRelative: path contains NUL byte');
    }
    const absPosix = toPosix(absPath);
    const root = this.mountPosix;
    const compareAbs = this.isWindowsMount ? absPosix.toLowerCase() : absPosix;
    const compareRoot = this.isWindowsMount ? root.toLowerCase() : root;

    if (compareAbs !== compareRoot && !compareAbs.startsWith(compareRoot + '/')) {
      throw new Error(`Path ${absPath} is not inside library mount ${this.mountPath}`);
    }

    if (compareAbs === compareRoot) return '';
    return absPosix.slice(root.length + 1);
  }

  /**
   * Convert a POSIX-relative DB path back into an absolute path on this
   * machine using the host OS separator.
   *
   * Security: rejects any input that would escape the library root. All IPC
   * handlers that touch the filesystem funnel through here, so this is the
   * single chokepoint enforcing that user-supplied (or DB-supplied)
   * relative paths cannot traverse to arbitrary disk locations.
   */
  toAbsolute(relPath: string): string {
    if (isAbsolute(relPath)) {
      throw new Error(`toAbsolute requires a relative path, got: ${relPath}`);
    }
    if (relPath.includes('\0')) {
      throw new Error('toAbsolute: path contains NUL byte');
    }
    const cleanRel = relPath.replace(/^[/\\]+/, '');
    if (cleanRel === '') return this.mountPath;
    // Reject any `..` segment. We check segments rather than substrings so a
    // legitimate filename like `model..bak` is allowed; only the literal `..`
    // path component (split on either separator) escapes the mount.
    for (const seg of cleanRel.split(/[/\\]+/)) {
      if (seg === '..') {
        throw new Error(`toAbsolute: path escapes library root: ${relPath}`);
      }
    }
    if (this.isWindowsMount) {
      return this.mountPath + '\\' + cleanRel.replace(/\//g, '\\');
    }
    return this.mountPath + '/' + cleanRel;
  }

  getMountPath(): string {
    return this.mountPath;
  }
}

/**
 * Heuristic: does this absolute path look like it lives on a network mount?
 * SQLite WAL mode corrupts over network filesystems so the DB layer needs
 * to know to fall back to TRUNCATE journal mode for these.
 */
export function looksLikeNetworkMount(absPath: string): boolean {
  if (WIN_UNC_RE.test(absPath)) return true;
  // macOS mounts external/network volumes under /Volumes/.
  if (absPath.startsWith('/Volumes/')) return true;
  // Linux: /mnt and /media are conventional but not authoritative.
  if (absPath.startsWith('/mnt/') || absPath.startsWith('/media/')) return true;
  return false;
}
