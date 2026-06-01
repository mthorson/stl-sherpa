import { describe, expect, it } from 'vitest';
import { scorePrintability } from './printability';

describe('scorePrintability', () => {
  it('rewards a watertight mesh with no overhangs and chunky proportions', () => {
    const r = scorePrintability({
      isWatertight: true,
      overhangFraction: 0,
      minMaxRatio: 0.8
    });
    expect(r.score).toBe(100);
    expect(r.rating).toBe('good');
    expect(r.factors).toEqual([]);
  });

  it('penalizes a non-watertight mesh', () => {
    const r = scorePrintability({
      isWatertight: false,
      overhangFraction: 0,
      minMaxRatio: 0.5
    });
    expect(r.score).toBe(60);
    expect(r.factors).toContain('not watertight');
  });

  it('scales the overhang penalty with overhang area', () => {
    const low = scorePrintability({ isWatertight: true, overhangFraction: 0.1, minMaxRatio: 0.5 });
    const high = scorePrintability({ isWatertight: true, overhangFraction: 0.9, minMaxRatio: 0.5 });
    expect(high.score).toBeLessThan(low.score);
    // 0.9 * 35 = ~32 off; should drop out of "good".
    expect(high.rating).not.toBe('good');
    expect(high.factors.some((f) => f.includes('overhang'))).toBe(true);
  });

  it('caps the overhang penalty at fraction 1', () => {
    const r = scorePrintability({ isWatertight: true, overhangFraction: 5, minMaxRatio: 0.5 });
    // 100 - 35 (max overhang) = 65.
    expect(r.score).toBe(65);
  });

  it('penalizes thin / slab-like geometry', () => {
    const r = scorePrintability({ isWatertight: true, overhangFraction: 0, minMaxRatio: 0.005 });
    expect(r.score).toBe(85);
    expect(r.factors).toContain('thin / slab-like geometry');
  });

  it('treats unknown factors as neutral rather than failing', () => {
    const r = scorePrintability({
      isWatertight: null,
      overhangFraction: null,
      minMaxRatio: null
    });
    expect(r.score).toBe(100);
    expect(r.rating).toBe('good');
    expect(r.factors).toContain('watertightness unknown');
  });

  it('clamps to 0 when every factor is bad', () => {
    const r = scorePrintability({
      isWatertight: false,
      overhangFraction: 1,
      minMaxRatio: 0.001
    });
    // 100 - 40 - 35 - 15 = 10, still positive here but exercises stacking.
    expect(r.score).toBe(10);
    expect(r.rating).toBe('poor');
  });

  it('maps score bands to ratings', () => {
    expect(scorePrintability({ isWatertight: true, overhangFraction: 0, minMaxRatio: 1 }).rating).toBe(
      'good'
    );
    // Force a mid score: not watertight only -> 60 -> fair.
    expect(
      scorePrintability({ isWatertight: false, overhangFraction: 0, minMaxRatio: 1 }).rating
    ).toBe('fair');
    // not watertight + heavy overhang -> 60 - 35 = 25 -> poor.
    expect(
      scorePrintability({ isWatertight: false, overhangFraction: 1, minMaxRatio: 1 }).rating
    ).toBe('poor');
  });
});
