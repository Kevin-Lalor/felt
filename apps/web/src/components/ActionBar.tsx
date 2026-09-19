import { useEffect, useMemo, useState } from 'react';
import { send } from '../socket';
import { useStore } from '../store';
import { formatClock, useCountdown } from '../clock';

export function ActionBar() {
  const view = useStore((s) => s.view);
  const legal = view?.legal ?? null;
  const [sizing, setSizing] = useState<number | null>(null);
  const msLeft = useCountdown(view?.actionDeadline ?? null);

  const bounds = useMemo(() => {
    if (!legal) return null;
    if (legal.canRaise) return { min: legal.minRaise, max: legal.maxRaise, kind: 'raise' as const };
    if (legal.canBet) return { min: legal.minBet, max: legal.maxBet, kind: 'bet' as const };
    return null;
  }, [legal]);

  useEffect(() => {
    setSizing(null); // re-anchor to the minimum every time it becomes your turn
  }, [view?.actingSeat, view?.handNumber]);

  const amount = sizing ?? bounds?.min ?? 0;

  // Keyboard: F fold, C check/call, R bet/raise, A all-in (build plan §5.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!legal || e.target instanceof HTMLInputElement) return;
      const handNumber = view?.handNumber ?? 0;
      if (e.key === 'f' && legal.canFold) send({ type: 'action', handNumber, action: { kind: 'fold' } });
      if (e.key === 'c') {
        if (legal.canCheck) send({ type: 'action', handNumber, action: { kind: 'check' } });
        else if (legal.canCall) send({ type: 'action', handNumber, action: { kind: 'call' } });
      }
      if (e.key === 'r' && bounds) {
        send({ type: 'action', handNumber, action: { kind: bounds.kind, to: amount } });
      }
      if (e.key === 'a' && legal.canAllIn) send({ type: 'action', handNumber, action: { kind: 'allIn' } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [legal, bounds, amount, view?.handNumber]);

  if (!view || !legal) {
    const seated = view?.yourSeat !== null && view?.yourSeat !== undefined;
    const inHand = view && ['preflop', 'flop', 'turn', 'river'].includes(view.street);
    return (
      <footer className="actionbar actionbar--idle">
        <span className="actionbar__hint">
          {!seated
            ? 'Tap an open seat to buy in.'
            : inHand
              ? 'Waiting for the action to reach you…'
              : ' '}
        </span>
      </footer>
    );
  }

  const handNumber = view.handNumber;
  const pot = view.potTotal;
  const toCall = legal.callAmount;
  const potOdds =
    toCall > 0 && pot > 0 ? `Pot odds ${(pot / toCall).toFixed(1)} : 1 — call ${toCall} to win ${pot}` : null;

  const clampedPreset = (fraction: number): number => {
    if (!bounds) return 0;
    const base = bounds.kind === 'raise' ? view.currentBet * 2 + pot : pot;
    const target = Math.round(base * fraction);
    return Math.min(Math.max(target, bounds.min), bounds.max);
  };

  return (
    <footer className="actionbar">
      <div className="actionbar__row actionbar__row--info">
        {msLeft !== null && (
          <span className={`pill${msLeft < 10_000 ? ' pill--warn' : ' pill--accent'}`}>
            {formatClock(msLeft)}
          </span>
        )}
        {potOdds && <span className="pill pill--accent">{potOdds}</span>}
        <span className="actionbar__spacer" />
        <span className="actionbar__keys">F fold · C check/call · R raise · A all-in</span>
      </div>

      {bounds && (
        <div className="actionbar__row actionbar__row--sizing">
          {(
            [
              ['½', 0.5],
              ['⅔', 0.67],
              ['Pot', 1],
            ] as const
          ).map(([label, fraction]) => (
            <button
              key={label}
              className={`pill${amount === clampedPreset(fraction) ? ' pill--on' : ''}`}
              onClick={() => setSizing(clampedPreset(fraction))}
            >
              {label}
            </button>
          ))}
          <button
            className={`pill${amount === bounds.max ? ' pill--on' : ''}`}
            onClick={() => setSizing(bounds.max)}
          >
            All in
          </button>
          <input
            className="actionbar__slider"
            type="range"
            min={bounds.min}
            max={bounds.max}
            value={amount}
            onChange={(e) => setSizing(Number(e.target.value))}
            aria-label="bet size"
          />
          <input
            className="actionbar__amount"
            type="number"
            min={bounds.min}
            max={bounds.max}
            value={amount}
            onChange={(e) => setSizing(Number(e.target.value))}
            aria-label="bet amount"
          />
        </div>
      )}

      <div className="actionbar__row actionbar__row--buttons">
        {legal.canFold && (
          <button
            className="btn btn--fold"
            onClick={() => send({ type: 'action', handNumber, action: { kind: 'fold' } })}
          >
            Fold
          </button>
        )}
        {legal.canCheck && (
          <button
            className="btn btn--check"
            onClick={() => send({ type: 'action', handNumber, action: { kind: 'check' } })}
          >
            Check
          </button>
        )}
        {legal.canCall && (
          <button
            className="btn btn--call"
            onClick={() => send({ type: 'action', handNumber, action: { kind: 'call' } })}
          >
            Call {toCall.toLocaleString()}
          </button>
        )}
        {bounds && (
          <button
            className="btn btn--raise"
            onClick={() =>
              send({ type: 'action', handNumber, action: { kind: bounds.kind, to: amount } })
            }
          >
            {bounds.kind === 'raise' ? 'Raise to' : 'Bet'} {amount.toLocaleString()}
          </button>
        )}
        {!bounds && legal.canAllIn && (
          <button
            className="btn btn--raise"
            onClick={() => send({ type: 'action', handNumber, action: { kind: 'allIn' } })}
          >
            All in {legal.allInAmount.toLocaleString()}
          </button>
        )}
      </div>
    </footer>
  );
}
