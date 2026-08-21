import { useState } from 'react';
import type { SeatView } from '@poker/protocol';
import { send } from '../socket';
import { useStore } from '../store';
import { CardBack, CardFace } from './Cards';
import { AVATARS } from './Join';
import { ActionBar } from './ActionBar';
import { Rail } from './Rail';

// Seat anchor points on the felt ellipse, clockwise from bottom-centre —
// straight from the wireframe kit (frame 1j). The view rotates so YOUR seat is
// always the bottom-centre anchor.
const ANCHORS: readonly { left: number; top: number }[] = [
  { left: 50, top: 100 },
  { left: 12, top: 88 },
  { left: -3, top: 52 },
  { left: 9, top: 14 },
  { left: 36, top: -4 },
  { left: 64, top: -4 },
  { left: 91, top: 14 },
  { left: 103, top: 52 },
  { left: 88, top: 88 },
];

function SeatPlate({
  seat,
  isHero,
  isActing,
  isButton,
  award,
  onSit,
}: {
  seat: SeatView;
  isHero: boolean;
  isActing: boolean;
  isButton: boolean;
  award: number;
  onSit: (() => void) | null;
}) {
  if (seat.playerId === null) {
    return onSit ? (
      <button className="seat seat--empty" onClick={onSit}>
        SEAT {seat.index + 1} · OPEN
      </button>
    ) : (
      <div className="seat seat--empty seat--empty-quiet">SEAT {seat.index + 1}</div>
    );
  }

  const folded = seat.status === 'folded';
  const classes = [
    'seat',
    isHero ? 'seat--hero' : '',
    isActing ? 'seat--acting' : '',
    folded ? 'seat--folded' : '',
    seat.isAllIn ? 'seat--allin' : '',
    !seat.connected ? 'seat--away' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const cards = seat.holeCards ?? seat.shownCards;

  return (
    <div className={classes}>
      <span className="seat__avatar" aria-hidden>
        {AVATARS[seat.avatar ?? 0]}
        {isButton && <span className="seat__button-disc" title="dealer button">D</span>}
      </span>
      <span className="seat__info">
        <span className="seat__name">{seat.name}</span>
        <span className="seat__stack">
          {folded ? 'FOLDED' : seat.isAllIn ? 'ALL IN' : seat.stack.toLocaleString()}
          {!seat.connected && ' · away'}
        </span>
      </span>
      <span className="seat__cards">
        {cards
          ? cards.map((c, i) => <CardFace key={i} card={c} size={isHero ? 'md' : 'sm'} />)
          : seat.hasCards && !folded
            ? [0, 1].map((i) => <CardBack key={i} size="sm" />)
            : null}
      </span>
      {seat.committedThisStreet > 0 && (
        <span className="seat__bet">{seat.committedThisStreet.toLocaleString()}</span>
      )}
      {award > 0 && <span className="seat__award">+{award.toLocaleString()}</span>}
    </div>
  );
}

export function Table() {
  const view = useStore((s) => s.view);
  const isHost = useStore((s) => s.isHost);
  const connected = useStore((s) => s.connected);
  const awards = useStore((s) => s.awards);
  const lastError = useStore((s) => s.lastError);
  const [sitSeat, setSitSeat] = useState<number | null>(null);
  const [buyIn, setBuyIn] = useState(200);

  if (!view) return <div className="loading">Taking your seat…</div>;

  const hero = view.yourSeat;
  const seated = hero !== null;
  const rotation = hero ?? 0;
  const handLive = ['preflop', 'flop', 'turn', 'river'].includes(view.street);
  const heroSeat = hero !== null ? view.seats[hero] : undefined;
  // Show one / show both — only when your cards weren't already public: either
  // you folded, or the hand ended without a showdown.
  const showdownThisHand = useStore.getState().showdownThisHand;
  const canShow =
    view.street === 'complete' &&
    heroSeat?.holeCards !== undefined &&
    heroSeat.shownCards === undefined &&
    (heroSeat.status === 'folded' || !showdownThisHand);

  const awardBySeat = new Map<number, number>();
  for (const a of awards) awardBySeat.set(a.seat, (awardBySeat.get(a.seat) ?? 0) + a.amount);

  const seatedWithChips = view.seats.filter((s) => s.playerId !== null && s.stack > 0).length;

  return (
    <div className="tableScreen">
      <header className="topbar">
        <span className="topbar__logo">♠ FELT</span>
        <span className="pill">{view.tableName}</span>
        <span className="pill pill--quiet">
          {view.blinds.smallBlind}/{view.blinds.bigBlind}
          {view.blinds.ante > 0 ? ` · ante ${view.blinds.ante}` : ''}
        </span>
        {view.handNumber > 0 && <span className="pill pill--quiet">Hand #{view.handNumber}</span>}
        <span className="topbar__spacer" />
        {!connected && <span className="pill pill--warn">reconnecting…</span>}
        {seated && heroSeat && (
          <span className="topbar__stack">
            STACK {heroSeat.stack.toLocaleString()}
          </span>
        )}
      </header>

      <div className="tableArea">
        <div className="feltWrap">
          <div className="felt">
            <div className="felt__centre">
              {view.handNumber === 0 && (
                <div className="felt__waiting">
                  <p className="felt__waiting-big">
                    {seatedWithChips < 2
                      ? `Waiting on ${2 - seatedWithChips} more`
                      : 'Ready to deal'}
                  </p>
                  <p className="felt__waiting-small">MINIMUM 2 TO DEAL · {seatedWithChips} SEATED</p>
                  {isHost && seatedWithChips >= 2 && (
                    <button className="btn btn--accent" onClick={() => send({ type: 'startHand' })}>
                      Deal the first hand
                    </button>
                  )}
                  {!isHost && <p className="felt__waiting-small">THE HOST DEALS THE FIRST HAND</p>}
                </div>
              )}
              {view.handNumber > 0 && (
                <>
                  {view.potTotal > 0 && (
                    <div className="pot">
                      <span className="pot__label">POT</span>
                      <span className="pot__amount">{view.potTotal.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="board">
                    {view.board.map((c, i) => (
                      <CardFace key={i} card={c} size="lg" />
                    ))}
                    {handLive &&
                      Array.from({ length: 5 - view.board.length }, (_, i) => (
                        <CardBack key={`b${i}`} size="lg" />
                      ))}
                  </div>
                  {view.pots.length > 1 && (
                    <div className="sidepots">
                      {view.pots.map((p, i) => (
                        <span key={i} className="pill pill--quiet">
                          {i === 0 ? 'main' : `side ${i}`} {p.amount.toLocaleString()}
                        </span>
                      ))}
                    </div>
                  )}
                  {view.street === 'complete' && (
                    <p className="felt__waiting-small">NEXT HAND IS COMING…</p>
                  )}
                </>
              )}
            </div>

            {view.seats.map((seat) => {
              const anchor = ANCHORS[(seat.index - rotation + 9) % 9] ?? ANCHORS[0]!;
              return (
                <div
                  key={seat.index}
                  className="seatAnchor"
                  style={{ left: `${anchor.left}%`, top: `${anchor.top}%` }}
                >
                  <SeatPlate
                    seat={seat}
                    isHero={seat.index === hero}
                    isActing={view.actingSeat === seat.index}
                    isButton={view.handNumber > 0 && view.button === seat.index}
                    award={view.street === 'complete' ? (awardBySeat.get(seat.index) ?? 0) : 0}
                    onSit={
                      !seated
                        ? () => {
                            setSitSeat(seat.index);
                            setBuyIn(200);
                          }
                        : null
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>

        <Rail />
      </div>

      {canShow && heroSeat?.holeCards && (
        <div className="showBar">
          <span className="showBar__label">Show your hand?</span>
          <button className="btn btn--small" onClick={() => send({ type: 'show', cards: 'first' })}>
            Show {heroSeat.holeCards[0]}
          </button>
          <button className="btn btn--small" onClick={() => send({ type: 'show', cards: 'second' })}>
            Show {heroSeat.holeCards[1]}
          </button>
          <button className="btn btn--small" onClick={() => send({ type: 'show', cards: 'both' })}>
            Show both
          </button>
        </div>
      )}

      <ActionBar />

      {sitSeat !== null && (
        <div className="modalScrim" onClick={() => setSitSeat(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">Sit down in seat {sitSeat + 1}</h2>
            <span className="join__label">BUY IN (100–400)</span>
            <div className="modal__buyins">
              {[100, 200, 400].map((amount) => (
                <button
                  key={amount}
                  className={`pill${buyIn === amount ? ' pill--on' : ''}`}
                  onClick={() => setBuyIn(amount)}
                >
                  {amount}
                </button>
              ))}
            </div>
            <button
              className="btn btn--accent"
              onClick={() => {
                send({ type: 'sit', seat: sitSeat, buyIn });
                setSitSeat(null);
              }}
            >
              Sit in seat {sitSeat + 1} — buy in {buyIn}
            </button>
            <button className="btn btn--ghost" onClick={() => setSitSeat(null)}>
              Just watch first
            </button>
          </div>
        </div>
      )}

      {lastError && Date.now() - lastError.at < 4000 && (
        <div className="toast" key={lastError.at}>
          {lastError.message}
        </div>
      )}
    </div>
  );
}
