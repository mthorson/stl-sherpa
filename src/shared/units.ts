import type { Unit } from './preferences';

const MM_PER_INCH = 25.4;

/**
 * Format a length in millimeters according to the user's display unit.
 * 3D files (STL especially) don't carry units — the number stored is whatever
 * the modeling tool wrote, and most everyone treats it as mm. The unit toggle
 * is a display preference, not a conversion of the underlying mesh data.
 */
export function formatDimension(mm: number, unit: Unit, fractionDigits = 2): string {
  if (!Number.isFinite(mm)) return '—';
  if (unit === 'in') {
    const inches = mm / MM_PER_INCH;
    return `${inches.toFixed(fractionDigits)} in`;
  }
  return `${mm.toFixed(fractionDigits)} mm`;
}

export function formatVolume(mmCubed: number, unit: Unit): string {
  if (!Number.isFinite(mmCubed)) return '—';
  if (unit === 'in') {
    const cubicIn = mmCubed / Math.pow(MM_PER_INCH, 3);
    return `${cubicIn.toFixed(2)} in³`;
  }
  // Above 1cm³ switch to cm³ for readability.
  if (mmCubed > 1000) {
    return `${(mmCubed / 1000).toFixed(2)} cm³`;
  }
  return `${mmCubed.toFixed(2)} mm³`;
}
