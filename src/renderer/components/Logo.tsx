interface Props {
  size?: number;
}

/**
 * Isometric storage cube — three visible faces, a luminous top, indigo
 * wireframe. Reads as both "3D model" and "stl-sherpa box" at small sizes.
 * Pure SVG so it stays crisp at any resolution and inherits the surrounding
 * dark/light theme without extra plumbing.
 */
export function Logo({ size = 24 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="stl-sherpa"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="wh3d-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c7d2fe" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
        <linearGradient id="wh3d-left" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" stopOpacity="0.55" />
          <stop offset="1" stopColor="#3730a3" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="wh3d-right" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#312e81" stopOpacity="0.55" />
          <stop offset="1" stopColor="#1e1b4b" stopOpacity="0.25" />
        </linearGradient>
      </defs>
      {/* Top face — lit */}
      <path d="M16 3 L29 10.5 L16 18 L3 10.5 Z" fill="url(#wh3d-top)" />
      {/* Left face */}
      <path d="M3 10.5 L16 18 L16 30 L3 22.5 Z" fill="url(#wh3d-left)" />
      {/* Right face */}
      <path d="M29 10.5 L16 18 L16 30 L29 22.5 Z" fill="url(#wh3d-right)" />
      {/* Wireframe outline — drawn on top so corners stay crisp */}
      <g
        fill="none"
        stroke="#a5b4fc"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d="M16 3 L29 10.5 L29 22.5 L16 30 L3 22.5 L3 10.5 Z" />
        <path d="M3 10.5 L16 18 L29 10.5" />
        <path d="M16 18 L16 30" />
      </g>
    </svg>
  );
}
