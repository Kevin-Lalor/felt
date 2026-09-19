import type { PlayerSkin } from '@poker/protocol';

// Chips. Each player's bets render in THEIR chosen colour and style, which
// everyone at the table sees — a player skin, not a local preference
// (docs/DESIGN-SYSTEM.md). It also happens to be useful: at a glance you can
// tell whose chips are in front of whose seat.
//
// The outline is NOT decorative. docs/DESIGN-SYSTEM.md measured every chip
// colour against every felt and all of them fail 3:1 on their own — chip red
// on classic green is 1.58:1. `--chip-outline` is what makes a chip a chip
// rather than a smudge. Never remove it from `.chip`.

/** Standard denominations, largest first. */
const DENOMS = [1000, 500, 100, 25, 5, 1];

/** How many chips the fewest-chips breakdown of `amount` needs, capped so a
 *  200-big-blind shove doesn't try to draw forty discs. */
export function chipCount(amount: number, max = 5): number {
  let left = Math.max(0, Math.floor(amount));
  let chips = 0;
  for (const d of DENOMS) {
    while (left >= d && chips < max) {
      left -= d;
      chips += 1;
    }
    if (chips >= max) break;
  }
  return Math.max(amount > 0 ? 1 : 0, chips);
}

export function ChipStack({
  amount,
  skin,
  max = 5,
  size = 'md',
}: {
  amount: number;
  skin: PlayerSkin;
  max?: number;
  size?: 'sm' | 'md';
}) {
  const count = chipCount(amount, max);
  if (count === 0) return null;

  return (
    <span className={`chipStack chipStack--${size}`} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="chip"
          data-chip-style={skin.chipStyle}
          // A semantic token, never a literal — the palette lives in
          // packages/tokens/semantic.json under `chip` (hard rule 7).
          style={{ ['--chip-colour' as string]: `var(--chip-${skin.chipColour})` }}
        />
      ))}
    </span>
  );
}
