/**
 * Photography-style lighting presets — pure data.
 *
 * Each preset is a self-contained const so you can tweak lights, colors,
 * intensities, or exposure in isolation without touching the LightingRig
 * applier. Adding a new preset means:
 *   1. Add an ID to `LIGHTING_STYLE_IDS` in `src/shared/lighting-types.ts`
 *   2. Add a new const here and append to `LIGHTING_PRESETS` + `PRESETS_BY_ID`
 *
 * Hex colors are RGB integers (e.g. 0xfff0e0 = warm white). Intensities are
 * physically-based; values look high because they're combined with ACES
 * Filmic tone mapping (set globally by LightingRig).
 */
import type { LightingStyle } from '@shared/lighting-types';

export interface DirectionalLightDef {
  color: number;
  intensity: number;
  /** World-space position; the light points toward the origin. */
  position: [number, number, number];
}

export interface HemisphereLightDef {
  skyColor: number;
  groundColor: number;
  intensity: number;
}

export interface AmbientLightDef {
  color: number;
  intensity: number;
}

export interface LightingPresetDefinition {
  id: LightingStyle;
  /** Short label for the UI picker. */
  label: string;
  /** One-line hint shown next to the picker. */
  description: string;
  /** Tone mapping exposure multiplier (1.0 = neutral). */
  exposure: number;
  /**
   * Strength of the baked-in RoomEnvironment IBL. 0 disables the env map
   * entirely (saves the PMREM bake); higher values brighten reflections on
   * metallic / glossy materials.
   */
  environmentIntensity: number;
  ambient?: AmbientLightDef;
  hemisphere?: HemisphereLightDef;
  directionals?: readonly DirectionalLightDef[];
}

// ─── Studio ──────────────────────────────────────────────────────────────

export const STUDIO_PRESET: LightingPresetDefinition = {
  id: 'studio',
  label: 'Studio',
  description: 'Balanced three-point lighting with a rim light. The best general-purpose look.',
  exposure: 0.85,
  environmentIntensity: 0.4,
  ambient: { color: 0xffffff, intensity: 0.2 },
  directionals: [
    // Key: warm, front-right, well above — strong downward angle so shadows
    // fall onto whatever's underneath the geometry.
    { color: 0xfff0e0, intensity: 3.0, position: [2.5, 6, 2.5] },
    // Fill: cool, opposite side, lower
    { color: 0xb8d4ff, intensity: 1.0, position: [-3, 0.5, 1.5] },
    // Rim: cool-white from behind, picks out silhouette
    { color: 0xeaf0ff, intensity: 1.85, position: [-1, 2.5, -3] }
  ]
};

// ─── Normals ─────────────────────────────────────────────────────────────

/**
 * Faux normal-map visualization: six axis-aligned colored directional lights
 * paint each face of the model with the canonical normal-map colors so the
 * surface orientation reads at a glance.
 *
 *   +X → red    -X → cyan       (R channel encodes X)
 *   +Y → green  -Y → magenta    (G channel encodes Y)
 *   +Z → blue   -Z → yellow     (B channel encodes Z)
 *
 * It's not a true per-pixel tangent-space normal map (that needs a shader),
 * but the cardinal-direction colors are unmistakable for spotting flipped
 * faces, hidden seams, and topology issues.
 */
export const NORMALS_PRESET: LightingPresetDefinition = {
  id: 'normals',
  label: 'Normals',
  description: 'Color-codes surface direction, which helps spot flipped faces and topology issues.',
  // Lower exposure than other presets so the saturated colors don't clip.
  exposure: 0.8,
  // No IBL: env-map adds neutral fill that would wash out the color cues.
  environmentIntensity: 0,
  // Tiny pure-black ambient (no-op, kept as a deliberate "no fill" marker).
  ambient: { color: 0x000000, intensity: 0 },
  directionals: [
    { color: 0xff0000, intensity: 1.6, position: [1, 0, 0] }, // +X red
    { color: 0x00ffff, intensity: 1.6, position: [-1, 0, 0] }, // -X cyan
    { color: 0x00ff00, intensity: 1.6, position: [0, 1, 0] }, // +Y green
    { color: 0xff00ff, intensity: 1.6, position: [0, -1, 0] }, // -Y magenta
    { color: 0x0000ff, intensity: 1.6, position: [0, 0, 1] }, // +Z blue
    { color: 0xffff00, intensity: 1.6, position: [0, 0, -1] } // -Z yellow
  ]
};

// ─── Dramatic ────────────────────────────────────────────────────────────

export const DRAMATIC_PRESET: LightingPresetDefinition = {
  id: 'dramatic',
  label: 'Dramatic',
  description: 'A single strong key light with low ambient. Deep shadows and mood.',
  exposure: 0.8,
  environmentIntensity: 0.12,
  ambient: { color: 0xffffff, intensity: 0.07 },
  directionals: [
    // Single strong warm key from above-right — steep enough that shadows
    // fall down across the model rather than slicing it horizontally.
    { color: 0xffe9c8, intensity: 5.0, position: [2.5, 5, 2] },
    // Cool opposite fill — a touch stronger than before so the shadow side
    // keeps just enough form to read instead of going near-black.
    { color: 0x6080a0, intensity: 0.6, position: [-2, 0.5, -0.5] }
  ]
};

// ─── Product ─────────────────────────────────────────────────────────────

export const PRODUCT_PRESET: LightingPresetDefinition = {
  id: 'product',
  label: 'Product',
  description: 'Clean, low-contrast fill from all around. Good for catalog-style shots.',
  exposure: 0.9,
  environmentIntensity: 0.7,
  // Higher ambient + multiple soft fills = catalog look with no harsh shadows.
  ambient: { color: 0xffffff, intensity: 0.4 },
  directionals: [
    { color: 0xffffff, intensity: 1.85, position: [0, 4, 2] }, // top-front
    { color: 0xffffff, intensity: 1.2, position: [3, 1, 1] }, // right
    { color: 0xffffff, intensity: 1.2, position: [-3, 1, 1] }, // left
    { color: 0xffffff, intensity: 1.35, position: [0, 2, -3] } // back rim
  ]
};

// ─── Outdoor ─────────────────────────────────────────────────────────────

export const OUTDOOR_PRESET: LightingPresetDefinition = {
  id: 'outdoor',
  label: 'Outdoor',
  description: 'A warm low-angle key against a cool sky. Golden-hour feel.',
  exposure: 0.9,
  environmentIntensity: 0.55,
  // Warm sun low on the right; cool sky fill from above.
  ambient: { color: 0x6088b8, intensity: 0.2 },
  directionals: [
    { color: 0xffc585, intensity: 3.8, position: [4, 1.5, 2] }, // sun
    { color: 0xa8c8ff, intensity: 1.0, position: [-2, 4, -1] }, // sky
    { color: 0xe8f0ff, intensity: 1.35, position: [-1, 1, -3] } // backlight
  ]
};

// ─── registry ────────────────────────────────────────────────────────────

export const LIGHTING_PRESETS: readonly LightingPresetDefinition[] = [
  STUDIO_PRESET,
  NORMALS_PRESET,
  DRAMATIC_PRESET,
  PRODUCT_PRESET,
  OUTDOOR_PRESET
];

const PRESETS_BY_ID: Record<LightingStyle, LightingPresetDefinition> = {
  studio: STUDIO_PRESET,
  normals: NORMALS_PRESET,
  dramatic: DRAMATIC_PRESET,
  product: PRODUCT_PRESET,
  outdoor: OUTDOOR_PRESET
};

export function getLightingPreset(id: LightingStyle): LightingPresetDefinition {
  return PRESETS_BY_ID[id];
}
