import { describe, expect, it } from 'vitest';
import { parseFsutilDriveType } from './network-mount';

describe('parseFsutilDriveType', () => {
  it('recognizes mapped network drives', () => {
    expect(parseFsutilDriveType('Z: - Remote/Network Drive')).toBe(true);
  });

  it('recognizes local drive types', () => {
    expect(parseFsutilDriveType('C: - Fixed Drive')).toBe(false);
    expect(parseFsutilDriveType('E: - Removable Drive')).toBe(false);
    expect(parseFsutilDriveType('D: - CD-ROM Drive')).toBe(false);
    expect(parseFsutilDriveType('R: - RAM Disk')).toBe(false);
  });

  it('returns null for unrecognized output so callers can fall back', () => {
    expect(parseFsutilDriveType('')).toBe(null);
    expect(parseFsutilDriveType('Error: The system cannot find the drive specified.')).toBe(null);
  });
});
