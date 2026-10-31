/**
 * Colour tables of the dashboard pages, all taken from the approved mockup (symphony-glass-dashboard.html): text,
 * roles, status scales, operations, trace kinds, task tones, the dark "ink" grounds and the chip tones. tokens.ts
 * turns them into CSS variables; components.ts interpolates them into the client building blocks. Kept apart from
 * tokens.ts so components.ts can use them without an import cycle (tokens.ts embeds COMPONENTS_CSS).
 */

/** Text colours (--fg*), link colours and the focus ring colour. */
export const TEXT = {
  fg: '#e8eef9', fgStrong: '#f4f7fc', fg2: '#aab6cc', fg3: '#8b98b0', fgChip: '#c9d4e6', fgLabel: '#9aa8c0',
  fgMute: '#5b6678', fgFaint: '#7c879b', link: '#7dd3fc', linkHover: '#bae6fd',
} as const;

/** Role colours; "human" is the colour of a person in the score. */
export const ROLE_COLORS = {
  analyst: '#38bdf8', architect: '#a78bfa', developer: '#34d399', tester: '#fbbf24', docs: '#cbd5e1',
  reviewer: '#f472b6', security: '#fb923c', symphony: '#94a3b8', human: '#e8eef9',
} as const;

/** Status scales (Tailwind-style step numbers). */
export const SCALES = {
  green: { 400: '#34d399', 300: '#6ee7b7', 100: '#d1fae5' },
  amber: { 400: '#fbbf24', 300: '#fcd34d', 200: '#fde68a' },
  red: { 400: '#f87171', 300: '#fca5a5', 200: '#fecaca' },
  violet: { 400: '#a78bfa', 300: '#c4b5fd', 200: '#ddd6fe', 100: '#ede9fe' },
  sky: { 400: '#38bdf8', 300: '#7dd3fc', 100: '#e0f2fe' },
  gray: { 500: '#64748b', 400: '#94a3b8' },
} as const;

/** Colours of the system cards on the overview. */
export const SYSTEM_COLORS = {
  cpu: SCALES.sky[400], ram: SCALES.violet[400], disk: SCALES.green[400], load: SCALES.amber[400], slots: SCALES.green[400], github: '#cbd5e1',
} as const;

/** Operation colours (denied = ABGEWIESEN). */
export const OP_COLORS = { read: SCALES.sky[300], write: SCALES.amber[400], search: SCALES.violet[300], denied: SCALES.red[400] } as const;

/** Trace kinds. */
export const TRACE_COLORS = { tool: SCALES.sky[300], brain: SCALES.amber[400], subagent: SCALES.green[300], model: SCALES.violet[300], result: SCALES.red[400] } as const;

/**
 * Dark grounds and text on light grounds: active segment text, avatar badge ring, ring-gauge badge grounds
 * (amber / sky) and the icon colour on the green and red avatar badges.
 */
export const INK = { text: '#0b1220', ring: '#0b1222', amber: '#3b2a06', sky: '#0d2433', green: '#052e1f', red: '#3b0a0a' } as const;

/** Chip tones: light text colour and the base colour c of the border (c at .4) and the ground (c at .1). */
export const CHIP_TONES = {
  green: { text: SCALES.green[300], c: SCALES.green[400] },
  amber: { text: SCALES.amber[300], c: SCALES.amber[400] },
  red: { text: SCALES.red[300], c: SCALES.red[400] },
  violet: { text: SCALES.violet[200], c: SCALES.violet[400] },
  sky: { text: SCALES.sky[100], c: SCALES.sky[300] },
  gray: { text: SCALES.gray[400], c: SCALES.gray[500] },
} as const;

/**
 * Tints of a #rrggbb colour as `rgba(r, g, b, a)`. The mockup uses alpha .16/.32/.55/.6 for the avatar
 * and .24/.42 for score blocks.
 */
export function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`rgba: expected #rrggbb, got "${hex}"`);
  if (!(alpha >= 0 && alpha <= 1)) throw new Error(`rgba: alpha must be within [0, 1], got ${alpha}`);
  const n = parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const WAIT_TONE = { fg: SCALES.amber[200], bg: rgba(SCALES.amber[400], .12) } as const;
/** Task tones: text colour and background (pause looks like wait). */
export const TASK_TONES = {
  run: { fg: SCALES.green[100], bg: rgba(SCALES.green[400], .14) },
  next: { fg: SCALES.sky[100], bg: rgba(SCALES.sky[300], .14) },
  wait: WAIT_TONE,
  pause: WAIT_TONE,
  block: { fg: SCALES.red[200], bg: rgba(SCALES.red[400], .13) },
  done: { fg: SCALES.violet[200], bg: rgba(SCALES.violet[300], .12) },
} as const;
