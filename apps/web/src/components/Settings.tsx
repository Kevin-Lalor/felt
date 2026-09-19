import { useState } from 'react';
import { useStore } from '../store';
import { THEMES, bbLabel } from '../prefs';
import type { DeckMode, MotionMode } from '../prefs';
import { CardFace } from './Cards';

// Wireframe 1p: two-pane preferences with a pinned mini-table that reflects
// every choice. The panel covers the real table, so the preview is what makes
// a felt or deck change legible while you are picking it.
//
// Changes apply immediately — there is no Save. A home game does not need a
// commit/cancel dance for a felt colour, and applying live is what makes the
// preview honest.

type Pane = 'table' | 'cards' | 'display';

const PANES: readonly { id: Pane; label: string; hint: string }[] = [
  { id: 'table', label: 'Table', hint: 'Felt, rail, background' },
  { id: 'cards', label: 'Cards', hint: 'Suit colours' },
  { id: 'display', label: 'Display', hint: 'Stacks, motion' },
];

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button className="optRow" aria-pressed={on} onClick={() => onChange(!on)}>
      <span className="optRow__text">
        <span className="optRow__label">{label}</span>
        <span className="optRow__hint">{hint}</span>
      </span>
      <span className={`switch${on ? ' switch--on' : ''}`} aria-hidden>
        <span className="switch__knob" />
      </span>
    </button>
  );
}

function MiniTable() {
  const prefs = useStore((s) => s.prefs);
  const view = useStore((s) => s.view);
  const bigBlind = view?.blinds.bigBlind ?? 2;
  const potBB = bbLabel(248, bigBlind, prefs.showBB);
  const stackBB = bbLabel(1240, bigBlind, prefs.showBB);

  return (
    <div className="miniTable">
      <span className="miniTable__caption">PREVIEW</span>
      <div className="miniTable__felt">
        <div className="miniTable__centre">
          <div className="pot">
            <span className="pot__label">POT</span>
            <span className="pot__amount">
              248{potBB && <span className="bb"> · {potBB}</span>}
            </span>
          </div>
          {/* One card of each suit, so four-colour mode is visible at a glance. */}
          <div className="board">
            <CardFace card="As" size="sm" />
            <CardFace card="Kh" size="sm" />
            <CardFace card="7d" size="sm" />
            <CardFace card="2c" size="sm" />
          </div>
        </div>
      </div>
      {/* Outside the felt, in flow: absolutely positioning it over the felt made
          it collide with the board at phone width. */}
      <div className="miniTable__seat seat seat--acting">
        <span className="seat__avatar" aria-hidden>
          ♠
        </span>
        <span className="seat__info">
          <span className="seat__name">
            You<span className="seat__clock">0:28</span>
          </span>
          <span className="seat__stack">
            1,240{stackBB && <span className="bb"> · {stackBB}</span>}
          </span>
        </span>
        <span className="seat__timer" style={{ ['--timer-progress' as string]: '0.62' }} />
      </div>
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);
  const [pane, setPane] = useState<Pane>('table');

  return (
    <div className="modalScrim" onClick={onClose}>
      <div
        className="modal modal--settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings__head">
          <h2 className="modal__title">Settings</h2>
          <span className="settings__note">Saved on this device only</span>
          <button className="btn btn--small" onClick={onClose}>
            Done
          </button>
        </header>

        <div className="settings__body">
          <nav className="settings__nav">
            {PANES.map((p) => (
              <button
                key={p.id}
                className={`settings__navItem${pane === p.id ? ' settings__navItem--on' : ''}`}
                aria-current={pane === p.id}
                onClick={() => setPane(p.id)}
              >
                <span className="settings__navLabel">{p.label}</span>
                <span className="settings__navHint">{p.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings__pane">
            {pane === 'table' && (
              <>
                <p className="settings__lede">
                  Four themes ship with the app. Each sets the felt, the rail, the background and
                  the card back together.
                </p>
                <div className="swatches">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={`swatch${prefs.theme === t.id ? ' swatch--on' : ''}`}
                      aria-pressed={prefs.theme === t.id}
                      onClick={() => setPref({ theme: t.id })}
                    >
                      {/* data-theme scopes that theme's tokens to this swatch, so
                          every swatch shows its own colours, not the active one's. */}
                      <span className="swatch__vis" data-theme={t.id} aria-hidden>
                        <span className="swatch__felt" />
                      </span>
                      <span className="swatch__text">
                        <span className="swatch__name">{t.name}</span>
                        <span className="swatch__desc">{t.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {pane === 'cards' && (
              <>
                <p className="settings__lede">
                  Four-colour decks give diamonds and clubs their own colours. Easier to read
                  quickly, especially on a phone.
                </p>
                <div className="swatches">
                  {(
                    [
                      ['two-colour', 'Two colour', 'Traditional. Red and black.'],
                      ['four-colour', 'Four colour', 'Blue diamonds, green clubs.'],
                    ] as const
                  ).map(([id, name, desc]) => (
                    <button
                      key={id}
                      className={`swatch${prefs.deck === id ? ' swatch--on' : ''}`}
                      aria-pressed={prefs.deck === id}
                      onClick={() => setPref({ deck: id as DeckMode })}
                    >
                      <span
                        className="swatch__cards"
                        {...(id === 'four-colour' ? { 'data-deck': 'four-colour' } : {})}
                        aria-hidden
                      >
                        <CardFace card="As" size="sm" />
                        <CardFace card="Kh" size="sm" />
                        <CardFace card="7d" size="sm" />
                        <CardFace card="2c" size="sm" />
                      </span>
                      <span className="swatch__text">
                        <span className="swatch__name">{name}</span>
                        <span className="swatch__desc">{desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {pane === 'display' && (
              <>
                <p className="settings__lede">
                  These change what you see. They never change the game — nobody else is affected
                  by anything on this screen.
                </p>
                <Toggle
                  label="Show stacks in big blinds"
                  hint="1,240 · 620BB — alongside the chip count, not instead of it"
                  on={prefs.showBB}
                  onChange={(showBB) => setPref({ showBB })}
                />
                <Toggle
                  label="Faster animations"
                  hint="Halves every motion duration. Reduced-motion settings already override this."
                  on={prefs.motion === 'fast'}
                  onChange={(fast) => setPref({ motion: (fast ? 'fast' : 'normal') as MotionMode })}
                />
              </>
            )}
          </div>
        </div>

        <MiniTable />
      </div>
    </div>
  );
}
