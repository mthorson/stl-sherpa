import { describe, expect, it } from 'vitest';
import {
  PathResolver,
  isAbsolute,
  isPosixAbsolute,
  isWindowsAbsolute,
  looksLikeNetworkMount,
  toPosix
} from './paths';

describe('isAbsolute helpers', () => {
  it('detects POSIX absolute paths', () => {
    expect(isPosixAbsolute('/Volumes/Studio/models/x.glb')).toBe(true);
    expect(isPosixAbsolute('models/x.glb')).toBe(false);
    expect(isPosixAbsolute('')).toBe(false);
  });

  it('detects Windows drive paths', () => {
    expect(isWindowsAbsolute('Z:\\Studio\\models\\x.glb')).toBe(true);
    expect(isWindowsAbsolute('z:/Studio/models/x.glb')).toBe(true);
    expect(isWindowsAbsolute('C:\\')).toBe(true);
    expect(isWindowsAbsolute('models\\x.glb')).toBe(false);
  });

  it('detects Windows UNC paths', () => {
    expect(isWindowsAbsolute('\\\\nas\\share\\models\\x.glb')).toBe(true);
    expect(isWindowsAbsolute('\\\\nas\\share')).toBe(true);
    expect(isWindowsAbsolute('\\\\nas')).toBe(false);
  });

  it('isAbsolute combines both', () => {
    expect(isAbsolute('/foo')).toBe(true);
    expect(isAbsolute('Z:\\foo')).toBe(true);
    expect(isAbsolute('foo/bar')).toBe(false);
  });
});

describe('toPosix', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('Z:\\Studio\\models\\x.glb')).toBe('Z:/Studio/models/x.glb');
    expect(toPosix('/Volumes/Studio/x.glb')).toBe('/Volumes/Studio/x.glb');
  });
});

describe('PathResolver — POSIX mount (macOS NAS)', () => {
  const r = new PathResolver('/Volumes/Studio');

  it('round-trips a basic file', () => {
    const abs = '/Volumes/Studio/models/character/hero.glb';
    expect(r.toRelative(abs)).toBe('models/character/hero.glb');
    expect(r.toAbsolute('models/character/hero.glb')).toBe(abs);
  });

  it('returns empty string for the root itself', () => {
    expect(r.toRelative('/Volumes/Studio')).toBe('');
    expect(r.toAbsolute('')).toBe('/Volumes/Studio');
  });

  it('handles paths with spaces and unicode', () => {
    const abs = '/Volumes/Studio/models/Caractère Spécial/モデル.glb';
    expect(r.toRelative(abs)).toBe('models/Caractère Spécial/モデル.glb');
    expect(r.toAbsolute('models/Caractère Spécial/モデル.glb')).toBe(abs);
  });

  it('rejects paths outside the mount', () => {
    expect(() => r.toRelative('/Volumes/OtherDrive/file.glb')).toThrow(
      /not inside library mount/
    );
    // Sibling-prefix attack: /Volumes/StudioBackup must not match /Volumes/Studio
    expect(() => r.toRelative('/Volumes/StudioBackup/file.glb')).toThrow(
      /not inside library mount/
    );
  });

  it('rejects relative input to toRelative', () => {
    expect(() => r.toRelative('models/x.glb')).toThrow(/absolute path/);
  });

  it('rejects absolute input to toAbsolute', () => {
    expect(() => r.toAbsolute('/foo/bar')).toThrow(/relative path/);
    expect(() => r.toAbsolute('Z:\\foo')).toThrow(/relative path/);
  });

  it('strips a trailing slash from the mount path on construction', () => {
    const trailing = new PathResolver('/Volumes/Studio/');
    expect(trailing.toRelative('/Volumes/Studio/models/x.glb')).toBe('models/x.glb');
  });

  it('rejects .. segments that would escape the mount', () => {
    expect(() => r.toAbsolute('../etc/passwd')).toThrow(/escapes library root/);
    expect(() => r.toAbsolute('models/../../etc/passwd')).toThrow(/escapes library root/);
    expect(() => r.toAbsolute('models/foo/..')).toThrow(/escapes library root/);
    expect(() => r.toAbsolute('..')).toThrow(/escapes library root/);
    expect(() => r.toAbsolute('models\\..\\..\\etc')).toThrow(/escapes library root/);
    // Leading-separator strip must not let a traversal slip through. A
    // leading `/` is rejected at the absolute-path check first, but either
    // refusal blocks the escape.
    expect(() => r.toAbsolute('/../etc')).toThrow(/relative path|escapes library root/);
  });

  it('allows filenames that merely contain .. as substring', () => {
    expect(r.toAbsolute('models/file..bak.glb')).toBe('/Volumes/Studio/models/file..bak.glb');
    expect(r.toAbsolute('..hidden/x.glb')).toBe('/Volumes/Studio/..hidden/x.glb');
  });

  it('rejects NUL bytes in paths', () => {
    expect(() => r.toAbsolute('models/x\0.glb')).toThrow(/NUL byte/);
    expect(() => r.toRelative('/Volumes/Studio/x\0.glb')).toThrow(/NUL byte/);
  });
});

describe('PathResolver — Windows drive mount', () => {
  const r = new PathResolver('Z:\\Studio');

  it('round-trips a basic file using OS separators on output', () => {
    const abs = 'Z:\\Studio\\models\\character\\hero.glb';
    expect(r.toRelative(abs)).toBe('models/character/hero.glb');
    expect(r.toAbsolute('models/character/hero.glb')).toBe(abs);
  });

  it('treats Windows drive letters case-insensitively', () => {
    // User mounts as Z:\Studio but a tool emits z:\studio\... — should still match.
    expect(r.toRelative('z:\\studio\\models\\hero.glb')).toBe('models/hero.glb');
  });

  it('rejects paths outside the mount', () => {
    expect(() => r.toRelative('Y:\\Other\\file.glb')).toThrow(/not inside library mount/);
  });

  it('handles trailing backslash on construction', () => {
    const trailing = new PathResolver('Z:\\Studio\\');
    expect(trailing.toRelative('Z:\\Studio\\x.glb')).toBe('x.glb');
  });
});

describe('PathResolver — Windows UNC mount', () => {
  const r = new PathResolver('\\\\nas01\\studio');

  it('round-trips a UNC-rooted file', () => {
    const abs = '\\\\nas01\\studio\\models\\hero.glb';
    expect(r.toRelative(abs)).toBe('models/hero.glb');
    expect(r.toAbsolute('models/hero.glb')).toBe(abs);
  });
});

describe('Cross-platform DB portability — same DB, different mounts', () => {
  // The whole point of the design: a relative path written by a Mac client
  // resolves correctly when read by a Windows client of the same DB.
  it('Mac writes, Windows reads', () => {
    const mac = new PathResolver('/Volumes/Studio');
    const win = new PathResolver('Z:\\Studio');
    const macAbs = '/Volumes/Studio/models/character/hero.glb';
    const stored = mac.toRelative(macAbs);
    expect(stored).toBe('models/character/hero.glb');
    expect(win.toAbsolute(stored)).toBe('Z:\\Studio\\models\\character\\hero.glb');
  });

  it('Windows writes, Mac reads', () => {
    const mac = new PathResolver('/Volumes/Studio');
    const win = new PathResolver('Z:\\Studio');
    const winAbs = 'Z:\\Studio\\models\\character\\hero.glb';
    const stored = win.toRelative(winAbs);
    expect(stored).toBe('models/character/hero.glb');
    expect(mac.toAbsolute(stored)).toBe('/Volumes/Studio/models/character/hero.glb');
  });
});

describe('looksLikeNetworkMount', () => {
  it('flags macOS /Volumes mounts', () => {
    expect(looksLikeNetworkMount('/Volumes/Studio')).toBe(true);
  });

  it('flags Windows UNC paths', () => {
    expect(looksLikeNetworkMount('\\\\nas01\\studio')).toBe(true);
  });

  it('does not flag local user paths', () => {
    expect(looksLikeNetworkMount('/Users/matt/projects/foo')).toBe(false);
    expect(looksLikeNetworkMount('C:\\Users\\matt\\foo')).toBe(false);
  });
});
