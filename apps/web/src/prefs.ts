// Per-viewer display preferences.
//
// These are LOCAL. They never reach the server, never enter the protocol, and
// never affect gameplay — a cosmetic that could change timing or information
// would be a fairness problem, not a preference (CLAUDE.md).
//
// Every entry here must map to something that ACTUALLY TAKES EFFECT: a data-
// attribute the generated token CSS reads, or a format this app applies. The
// repo already has one catalogue of cosmetics that nothing reads
// (packages/tokens/cosmetics.json); do not add a second by shipping a picker
// for an option with no implementation behind it.

import type { PlayerSkin } from '@poker/protocol';

export type DeckMode = 'two-colour' | 'four-colour';
export type MotionMode = 'normal' | 'fast';
export type CardBackPattern = 'weave' | 'lattice' | 'dots' | 'chevron' | 'plain';
export type ChipUnit = 'chips' | 'bb';

/** Card-back patterns. LOCAL, not a player skin: a back only ever appears on a
 *  face-down card, so it shows you what other people's cards look like to YOU
 *  and nobody else sees your choice. docs/adr/0001 records why this moved out
 *  of the host's table theme. */
export const CARD_BACKS: readonly { id: CardBackPattern; name: string }[] = [
  { id: 'weave', name: 'Weave' },
  { id: 'lattice', name: 'Lattice' },
  { id: 'dots', name: 'Dots' },
  { id: 'chevron', name: 'Chevron' },
  { id: 'plain', name: 'Plain' },
];

/** Each maps to a --card-back-<id> semantic token. */
export const CARD_BACK_COLOURS: readonly { id: string; name: string }[] = [
  { id: 'mahogany', name: 'Mahogany' },
  { id: 'walnut', name: 'Walnut' },
  { id: 'charcoal', name: 'Charcoal' },
  { id: 'chrome', name: 'Chrome' },
  { id: 'brass', name: 'Brass' },
  { id: 'navy', name: 'Navy' },
  { id: 'burgundy', name: 'Burgundy' },
  { id: 'emerald', name: 'Emerald' },
];

export type Prefs = {
  /** → data-theme. Must match a FILENAME in packages/tokens/themes/, which is
   *  what build.ts uses for the selector — not the theme's `name` field. */
  theme: string;
  /** → data-deck */
  deck: DeckMode;
  /** → data-motion. prefers-reduced-motion already zeroes motion on its own. */
  motion: MotionMode;
  /** Show ALL stacks and pots in big blinds alongside chips (wireframe 1j). */
  showBB: boolean;
  /** → data-card-back */
  cardBack: CardBackPattern;
  /** → data-card-back-colour. '' means follow the table theme's card back. */
  cardBackColour: string;
  /** What YOUR OWN seat plate shows while showBB is off. Clicking the plate
   *  flips it, so you can check your stack depth without changing the table. */
  heroUnit: ChipUnit;
  /** Your chip cosmetics. null until you pick — while it is null the server's
   *  join-time colour rotation stands, which is what keeps a fresh table from
   *  being nine identical red stacks. This is a PLAYER SKIN: it is stored here
   *  only so it survives a reload, and the server is what everyone else sees. */
  skin: PlayerSkin | null;
};

export const CHIP_STYLES: readonly { id: PlayerSkin['chipStyle']; name: string; desc: string }[] = [
  { id: 'casino', name: 'Casino', desc: 'Clay, edge spots, denomination centre' },
  { id: 'ceramic', name: 'Ceramic', desc: 'Flat, full-face print' },
  { id: 'vintage', name: 'Vintage', desc: 'Worn edges, muted palette' },
  { id: 'neon', name: 'Neon', desc: 'Glow rim, dark core' },
  { id: 'minimal', name: 'Minimal', desc: 'Flat discs, numeral only' },
];

export const CHIP_COLOURS: readonly { id: PlayerSkin['chipColour']; name: string }[] = [
  { id: 'red', name: 'Red' },
  { id: 'blue', name: 'Blue' },
  { id: 'green', name: 'Green' },
  { id: 'yellow', name: 'Yellow' },
  { id: 'purple', name: 'Purple' },
  { id: 'orange', name: 'Orange' },
  { id: 'pink', name: 'Pink' },
  { id: 'white', name: 'White' },
  { id: 'black', name: 'Black' },
];

export const THEMES: readonly { id: string; name: string; description: string }[] = [
  { id: 'midnight-blue', name: 'Midnight', description: 'Low-glare navy. Best for late sessions.' },
  { id: 'classic-green', name: 'Classic Green', description: 'The felt you picture when someone says poker.' },
  { id: 'mono-slate', name: 'Slate', description: 'Neutral grey. Maximum contrast, minimum distraction.' },
  { id: 'vegas-red', name: 'Vegas', description: 'Burgundy felt, brass rail. Loud on purpose.' },
];

/** Midnight — decided 2026-09-19. */
export const DEFAULT_PREFS: Prefs = {
  theme: 'midnight-blue',
  deck: 'two-colour',
  motion: 'normal',
  showBB: false,
  cardBack: 'weave',
  cardBackColour: '', // follow the theme until the player picks one
  heroUnit: 'chips',
  skin: null, // until picked, the server's rotation decides
};

const KEY = 'felt.prefs';

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const theme = THEMES.some((t) => t.id === parsed.theme) ? (parsed.theme as string) : DEFAULT_PREFS.theme;
    return {
      theme,
      deck: parsed.deck === 'four-colour' ? 'four-colour' : 'two-colour',
      motion: parsed.motion === 'fast' ? 'fast' : 'normal',
      showBB: parsed.showBB === true,
      cardBack: CARD_BACKS.some((b) => b.id === parsed.cardBack)
        ? (parsed.cardBack as CardBackPattern)
        : DEFAULT_PREFS.cardBack,
      cardBackColour: CARD_BACK_COLOURS.some((c) => c.id === parsed.cardBackColour)
        ? (parsed.cardBackColour as string)
        : '',
      heroUnit: parsed.heroUnit === 'bb' ? 'bb' : 'chips',
      skin:
        parsed.skin &&
        CHIP_STYLES.some((s) => s.id === parsed.skin?.chipStyle) &&
        CHIP_COLOURS.some((c) => c.id === parsed.skin?.chipColour)
          ? { chipStyle: parsed.skin.chipStyle, chipColour: parsed.skin.chipColour }
          : null,
    };
  } catch {
    // Private windows and blocked site data both throw here. A viewer with no
    // storage still gets a working table on the default theme.
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* preferences are a convenience, never load-bearing */
  }
}

/** Drive the token CSS. Called at boot before first paint, and on every change. */
export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', prefs.theme);
  if (prefs.deck === 'four-colour') root.setAttribute('data-deck', 'four-colour');
  else root.removeAttribute('data-deck');
  if (prefs.motion === 'fast') root.setAttribute('data-motion', 'fast');
  else root.removeAttribute('data-motion');
  root.setAttribute('data-card-back', prefs.cardBack);
  if (prefs.cardBackColour) root.setAttribute('data-card-back-colour', prefs.cardBackColour);
  else root.removeAttribute('data-card-back-colour');
}

/** The big-blind companion to a chip count, or null when the toggle is off.
 *  Wireframe 1j shows it as a suffix — "1,240 · 620BB" — not a replacement. */
export function bbLabel(chips: number, bigBlind: number, showBB: boolean): string | null {
  if (!showBB || bigBlind <= 0) return null;
  const bb = chips / bigBlind;
  return `${bb >= 10 ? Math.round(bb) : bb.toFixed(1)}BB`;
}
