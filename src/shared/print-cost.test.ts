import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_COST_PREFS,
  estimateFilamentCost,
  estimateResinCost
} from './print-cost';

// 1 cm³ = 1000 mm³ — convenient unit cell for hand-verified expectations.
const ONE_CM3_IN_MM3 = 1000;

describe('print-cost: filament', () => {
  it('multiplies volume × PLA density × fill factor and converts to USD', () => {
    // 1 cm³ × 1.24 g/cm³ × 0.30 fill = 0.372 g
    // 0.372 g × ($12.99 / 1 kg) ÷ 1000 = $0.0048...
    const r = estimateFilamentCost(ONE_CM3_IN_MM3, DEFAULT_PRINT_COST_PREFS);
    expect(r.grams).toBeCloseTo(0.372, 5);
    expect(r.usd).toBeCloseTo(0.00483, 5);
  });

  it('scales linearly with mesh volume', () => {
    const a = estimateFilamentCost(ONE_CM3_IN_MM3, DEFAULT_PRINT_COST_PREFS);
    const b = estimateFilamentCost(ONE_CM3_IN_MM3 * 100, DEFAULT_PRINT_COST_PREFS);
    expect(b.grams).toBeCloseTo(a.grams * 100, 5);
    expect(b.usd).toBeCloseTo(a.usd * 100, 5);
  });

  it('halving the fill factor halves the filament estimate', () => {
    const full = estimateFilamentCost(ONE_CM3_IN_MM3 * 100, {
      ...DEFAULT_PRINT_COST_PREFS,
      filamentFillFactor: 1
    });
    const half = estimateFilamentCost(ONE_CM3_IN_MM3 * 100, {
      ...DEFAULT_PRINT_COST_PREFS,
      filamentFillFactor: 0.5
    });
    expect(half.grams).toBeCloseTo(full.grams / 2, 5);
    expect(half.usd).toBeCloseTo(full.usd / 2, 5);
  });

  it('normalizes price by package size — $20/2kg matches $10/1kg', () => {
    const oneKg = estimateFilamentCost(ONE_CM3_IN_MM3 * 100, {
      ...DEFAULT_PRINT_COST_PREFS,
      filament: { pricePerPackageUsd: 10, kgsPerPackage: 1 }
    });
    const twoKg = estimateFilamentCost(ONE_CM3_IN_MM3 * 100, {
      ...DEFAULT_PRINT_COST_PREFS,
      filament: { pricePerPackageUsd: 20, kgsPerPackage: 2 }
    });
    expect(twoKg.usd).toBeCloseTo(oneKg.usd, 8);
  });
});

describe('print-cost: resin', () => {
  it('uses resin density and always 100% fill', () => {
    // 1 cm³ × 1.10 g/cm³ = 1.10 g (fill always 1.0 for resin)
    // 1.10 g × ($25.99 / 2 kg) ÷ 1000 = $0.01429...
    const r = estimateResinCost(ONE_CM3_IN_MM3, DEFAULT_PRINT_COST_PREFS);
    expect(r.grams).toBeCloseTo(1.1, 5);
    expect(r.usd).toBeCloseTo(0.01429, 5);
  });

  it('ignores filamentFillFactor', () => {
    const a = estimateResinCost(ONE_CM3_IN_MM3 * 100, DEFAULT_PRINT_COST_PREFS);
    const b = estimateResinCost(ONE_CM3_IN_MM3 * 100, {
      ...DEFAULT_PRINT_COST_PREFS,
      filamentFillFactor: 0.05
    });
    expect(b.grams).toBeCloseTo(a.grams, 8);
    expect(b.usd).toBeCloseTo(a.usd, 8);
  });
});

describe('print-cost: defaults', () => {
  it('matches the values stated in the feature request', () => {
    expect(DEFAULT_PRINT_COST_PREFS.filament).toEqual({
      pricePerPackageUsd: 12.99,
      kgsPerPackage: 1
    });
    expect(DEFAULT_PRINT_COST_PREFS.resin).toEqual({
      pricePerPackageUsd: 25.99,
      kgsPerPackage: 2
    });
  });
});
