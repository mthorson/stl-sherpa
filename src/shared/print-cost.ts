/**
 * Rough material-cost estimate for 3D-printing the model. v1 hardcodes
 * PLA and standard resin densities and assumes USD pricing — the user-tunable
 * knobs are the price-per-package and (for filament) a fill factor that
 * covers walls + infill.
 */

export interface MaterialCostPreference {
  /** Price in USD for `kgsPerPackage` kg of material. */
  pricePerPackageUsd: number;
  /** Package size in kg (e.g. 1 for a typical filament spool, 2 for a
   *  bottle of resin). The app normalizes to per-kg internally. */
  kgsPerPackage: number;
}

export interface PrintCostPreferences {
  filament: MaterialCostPreference;
  resin: MaterialCostPreference;
  /** 0..1 — fraction of mesh volume that actually becomes filament
   *  (covers infill + walls). Resin always uses 1.0 because SLA prints
   *  are nearly solid. */
  filamentFillFactor: number;
}

export const DEFAULT_PRINT_COST_PREFS: PrintCostPreferences = {
  filament: { pricePerPackageUsd: 12.99, kgsPerPackage: 1 },
  resin: { pricePerPackageUsd: 25.99, kgsPerPackage: 2 },
  filamentFillFactor: 0.3
};

const PLA_DENSITY_G_PER_CM3 = 1.24;
const RESIN_DENSITY_G_PER_CM3 = 1.1;
const MM3_PER_CM3 = 1000;
const G_PER_KG = 1000;

export interface PrintCostEstimate {
  grams: number;
  usd: number;
}

function estimate(
  meshVolumeMm3: number,
  densityGPerCm3: number,
  material: MaterialCostPreference,
  fillFactor: number
): PrintCostEstimate {
  const volumeCm3 = meshVolumeMm3 / MM3_PER_CM3;
  const grams = volumeCm3 * densityGPerCm3 * fillFactor;
  const pricePerKg = material.pricePerPackageUsd / material.kgsPerPackage;
  const usd = (grams / G_PER_KG) * pricePerKg;
  return { grams, usd };
}

export function estimateFilamentCost(
  meshVolumeMm3: number,
  prefs: PrintCostPreferences
): PrintCostEstimate {
  return estimate(meshVolumeMm3, PLA_DENSITY_G_PER_CM3, prefs.filament, prefs.filamentFillFactor);
}

export function estimateResinCost(
  meshVolumeMm3: number,
  prefs: PrintCostPreferences
): PrintCostEstimate {
  return estimate(meshVolumeMm3, RESIN_DENSITY_G_PER_CM3, prefs.resin, 1);
}
