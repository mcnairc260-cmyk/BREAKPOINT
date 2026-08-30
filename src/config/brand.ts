/**
 * Dragon Phoenix Ascension brand palette, transcribed from
 * `brand/BRAND_BIBLE.md` §5, plus the functional colours the table itself
 * needs.
 *
 * The founder's ruling for EMBERLOOP (2026-08-20) was that games follow the
 * Brand Bible palette rather than the live site's; BREAKPOINT follows the same
 * ruling. The wider two-palette question in `docs/AI_ONBOARDING.md` §8.1 is
 * still open and is not resolved here.
 *
 * Nothing outside this file should hard-code a colour.
 */

export const BRAND = {
  voidBlack: 0x0a0a0f,
  carbon: 0x14141c,
  emberOrange: 0xff6b2c,
  rebirthGold: 0xffb300,
  signalCyan: 0x22d3ee,
  ghostWhite: 0xf4f4f5,
  steel: 0x8b8b99,
} as const;

/**
 * Type stacks, from Brand Bible §5 "Typography".
 *
 * Display is the Bible's squared geometric sans; data and HUD labels are its
 * monospace, which is what gives an interface the command-center flavour the
 * Constitution asks for. No web font is loaded: the game ships zero external
 * assets by design, and a render-blocking font request is the wrong trade on a
 * phone. These are preference lists, and the system fallbacks are close in
 * character.
 */
export const TYPE = {
  display: "'Space Grotesk', 'Sora', 'Rajdhani', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

export const BRAND_CSS = {
  voidBlack: '#0a0a0f',
  carbon: '#14141c',
  emberOrange: '#ff6b2c',
  rebirthGold: '#ffb300',
  signalCyan: '#22d3ee',
  ghostWhite: '#f4f4f5',
  steel: '#8b8b99',
} as const;

/**
 * Table materials.
 *
 * Cloth is a deep teal rather than the traditional billiard green: it sits in
 * the brand's dark, Signal-Cyan-adjacent register while still reading
 * unmistakably as cloth, and it keeps the ember accents as the only warm thing
 * on screen. Woods and rubber are near-black so the balls carry the contrast.
 */
export const TABLE = {
  cloth: 0x0d2932,
  clothEdge: 0x0a2028,
  railWood: 0x171720,
  railTop: 0x1e1e28,
  cushion: 0x0e262e,
  pocketVoid: 0x04040a,
  jaw: 0x0c0c12,
  chrome: 0x9aa4ad,
} as const;

/**
 * Ball colours.
 *
 * These are the standard pool set, not brand colours. Telling fifteen balls
 * apart at a glance is a hard gameplay requirement and the three brand accents
 * cannot do it — the same reasoning EMBERLOOP applied to its enemy signalling
 * hues. Indexed by ball number; index 0 is the cue ball.
 */
export const BALL_COLORS: readonly number[] = [
  0xf2f0e6, // cue — warm white, not pure white, so it still has shading
  0xf5c518, // 1 yellow
  0x1f5fd0, // 2 blue
  0xd93a2b, // 3 red
  0x6d3fa8, // 4 purple
  0xf07a1f, // 5 orange
  0x1e7a4a, // 6 green
  0x7d2733, // 7 maroon
  0x14141a, // 8 black
  0xf5c518, // 9 yellow stripe
  0x1f5fd0, // 10 blue stripe
  0xd93a2b, // 11 red stripe
  0x6d3fa8, // 12 purple stripe
  0xf07a1f, // 13 orange stripe
  0x1e7a4a, // 14 green stripe
  0x7d2733, // 15 maroon stripe
];

export const isStripe = (n: number): boolean => n >= 9 && n <= 15;
