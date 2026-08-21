const SUIT_GLYPHS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_CLASS: Record<string, string> = { s: 'spade', h: 'heart', d: 'diamond', c: 'club' };

export function CardFace({ card, size = 'md' }: { card: string; size?: 'sm' | 'md' | 'lg' }) {
  const rank = card[0] === 'T' ? '10' : (card[0] ?? '?');
  const suit = card[1] ?? 's';
  return (
    <span className={`card card--${size} card--${SUIT_CLASS[suit]}`} aria-label={card}>
      <span className="card__rank">{rank}</span>
      <span className="card__suit">{SUIT_GLYPHS[suit]}</span>
    </span>
  );
}

export function CardBack({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`card card--${size} card--back`} aria-label="face-down card" />;
}
