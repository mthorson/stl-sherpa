/**
 * Tiny templating engine for the Batch Rename feature.
 *
 * Tokens (all wrapped in `{` `}`):
 *   {name}              — original basename without extension
 *   {ext}               — original extension WITH leading dot (e.g. ".stl")
 *   {original}          — full original filename
 *   {counter}           — 1-based sequence index, no padding
 *   {counter:NN}        — counter padded to N digits with leading zeros
 *   {date:FORMAT}       — file mtime formatted; supports YYYY MM DD HH mm ss
 *
 * Unknown tokens are left in place verbatim so the user sees obvious typos
 * in the preview rather than silent eat-through.
 */

export interface RenameContext {
  /** Original filename (with extension). */
  filename: string;
  /** Original extension WITHOUT leading dot. */
  ext: string;
  /** File mtime in unix ms — for date tokens. */
  mtimeMs: number;
}

export function renderTemplate(
  ctx: RenameContext,
  index: number,
  total: number,
  template: string
): string {
  // Case-insensitive suffix check: `ext` is always lowercased by extensionOf,
  // but the on-disk filename may be HERO.STL. A case-sensitive check would
  // fail and make {name} return the full filename, extension included.
  const name = ctx.filename.toLowerCase().endsWith(`.${ctx.ext.toLowerCase()}`)
    ? ctx.filename.slice(0, -(ctx.ext.length + 1))
    : ctx.filename;
  const ext = ctx.ext ? `.${ctx.ext}` : '';
  const original = ctx.filename;

  return template.replace(/\{([^{}]+)\}/g, (whole, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === 'name') return name;
    if (trimmed === 'ext') return ext;
    if (trimmed === 'original') return original;
    if (trimmed === 'counter') return String(index + 1);
    const counterPad = /^counter:(\d+)$/.exec(trimmed);
    if (counterPad) {
      const width = Number.parseInt(counterPad[1], 10);
      return String(index + 1).padStart(width, '0');
    }
    const dateMatch = /^date:(.+)$/.exec(trimmed);
    if (dateMatch) return formatDate(new Date(ctx.mtimeMs), dateMatch[1]);
    // Unknown token — leave verbatim so the user sees it in preview.
    void total;
    return whole;
  });
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

/**
 * Check if a name would be illegal as a file basename on the current
 * platforms we care about (macOS + Windows). Used in the preview so the user
 * gets a warning before submit.
 */
export function isInvalidFilename(name: string): boolean {
  if (name.length === 0) return true;
  if (name === '.' || name === '..') return true;
  // Windows reserved characters + control chars
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return true;
  // Windows reserved device names — reserved with any extension (con.stl).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return true;
  // Windows silently strips trailing dots/spaces, desyncing DB from disk.
  if (/[. ]$/.test(name)) return true;
  return false;
}
