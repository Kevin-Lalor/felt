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

export type DeckMode = 'two-colour' | 'four-colour';
export type MotionMode = 'normal' | 'fast';

export type Prefs = {
  /** → data-theme. Must match a FILENAME in packages/tokens/themes/, which is
   *  what build.ts uses for the selector — not the theme's `name` field. */
  theme: string;
  /** → data-deck */
  deck: DeckMode;
  /** → data-motion. prefers-reduced-motion already zeroes motion on its own. */
  motion: MotionMode;
  /** Show stacks and pots in big blinds alongside chips (wireframe 1j). */
  showBB: boolean;
};

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
}

/** The big-blind companion to a chip count, or null when the toggle is off.
 *  Wireframe 1j shows it as a suffix — "1,240 · 620BB" — not a replacement. */
export function bbLabel(chips: number, bigBlind: number, showBB: boolean): string | null {
  if (!showBB || bigBlind <= 0) return null;
  const bb = chips / bigBlind;
  return `${bb >= 10 ? Math.round(bb) : bb.toFixed(1)}BB`;
}
