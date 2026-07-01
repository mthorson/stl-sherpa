/**
 * Star ratings and color labels — the triage primitives.
 *
 * Ratings are integers 0..5 (0 = unrated). Color labels are a small fixed
 * palette modeled on familiar photo-triage tools so 3D-printing users from
 * photography workflows feel at home.
 */

export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

const COLOR_LABEL_SET: ReadonlySet<string> = new Set(COLOR_LABELS);

export function isColorLabel(value: unknown): value is ColorLabel {
  return typeof value === 'string' && COLOR_LABEL_SET.has(value);
}

export const MIN_RATING = 0;
export const MAX_RATING = 5;

export function isValidRating(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_RATING &&
    value <= MAX_RATING
  );
}

export function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_RATING, Math.min(MAX_RATING, Math.round(value)));
}

/** CSS color values, chosen to read well on the dark-6 tile background. */
export const COLOR_LABEL_HEX: Record<ColorLabel, string> = {
  red: '#e03131',
  yellow: '#f59f00',
  green: '#37b24d',
  blue: '#1c7ed6',
  purple: '#7048e8'
};
