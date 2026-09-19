import { useState } from 'react';
import { useStore } from '../store';
import { send } from '../socket';
import {
  CARD_BACKS,
  CARD_BACK_COLOURS,
  CHIP_COLOURS,
  CHIP_STYLES,
  THEMES,
  bbLabel,
} from '../prefs';
import type { CardBackPattern, DeckMode, MotionMode } from '../prefs';
import type { PlayerSkin } from '@poker/protocol';
import { CardBack, CardFace } from './Cards';
import { ChipStack } from './Chips';

// Wireframe 1p: two-pane preferences with a pinned mini-table that reflects
// every choice. The panel covers the real table, so the preview is what makes
// a felt or deck change legible while you are picking it.
//
// Changes apply immediately — there is no Save. A home game does not need a
// commit/cancel dance for a felt colour, and applying live is what makes the
// preview honest.

type Pane = 'table' | 'cards' | 'chips' | 'display';

const PANES: readonly { id: Pane; label: string; hint: string }[] = [
  { id: 'table', label: 'Table', hint: 'Felt, rail, background' },
  { id: 'cards', label: 'Cards', hint: 'Suits and backs' },
  { id: 'chips', label: 'Chips', hint: 'Everyone sees these' },
  { id: 'display', label: 'Display', hint: 'Stacks, motion' },
];

/** The skin in force for you: what you have chosen, else whatever the server
 *  handed you at your seat, else the fallback. */
function useEffectiveSkin(): PlayerSkin {
  const chosen = useStore((s) => s.prefs.skin);
  const view = useStore((s) => s.view);
  if (chosen) return chosen;
  const seat = view?.yourSeat != null ? view.seats[view.yourSeat] : undefined;
  return seat?.skin ?? { chipStyle: 'casino', chipColour: 'red' };
}

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
  const skin = useEffectiveSkin();
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
          {/* One card of each suit, so four-colour mode is visible at a glance,
              plus a face-down card so the chosen back is visible too. */}
          <div className="board">
            <CardFace card="As" size="sm" />
            <CardFace card="Kh" size="sm" />
            <CardFace card="7d" size="sm" />
            <CardFace card="2c" size="sm" />
            <CardBack size="sm" />
          </div>
          <span className="miniTable__bet">
            <ChipStack amount={60} skin={skin} size="sm" />
            <span className="seat__bet-amount">60</span>
          </span>
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
  const skin = useEffectiveSkin();
  const [pane, setPane] = useState<Pane>('table');

  // A skin change is stored locally so it survives a reload AND sent to the
  // server, because everyone at the table renders your chips from it.
  const applySkin = (next: PlayerSkin): void => {
    setPref({ skin: next });
    send({ type: 'setSkin', skin: next });
  };

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

                <p className="settings__lede">
                  The back is what you see on <em>everyone else's</em> cards, all night. It
                  carries no information, so it is yours alone to pick — nobody else sees your
                  choice.
                </p>
                <div className="swatches">
                  {CARD_BACKS.map((b) => (
                    <button
                      key={b.id}
                      className={`swatch${prefs.cardBack === b.id ? ' swatch--on' : ''}`}
                      aria-pressed={prefs.cardBack === b.id}
                      onClick={() => setPref({ cardBack: b.id as CardBackPattern })}
                    >
                      <span
                        className="swatch__cards"
                        data-card-back={b.id}
                        {...(prefs.cardBackColour
                          ? { 'data-card-back-colour': prefs.cardBackColour }
                          : {})}
                        aria-hidden
                      >
                        <CardBack size="sm" />
                        <CardBack size="sm" />
                      </span>
                      <span className="swatch__text">
                        <span className="swatch__name">{b.name}</span>
                      </span>
                    </button>
                  ))}
                </div>

                <p className="settings__lede">Back colour</p>
                <div className="dotRow">
                  <button
                    className={`dot dot--theme${prefs.cardBackColour === '' ? ' dot--on' : ''}`}
                    aria-label="Follow the table theme"
                    aria-pressed={prefs.cardBackColour === ''}
                    onClick={() => setPref({ cardBackColour: '' })}
                  />
                  {CARD_BACK_COLOURS.map((c) => (
                    <button
                      key={c.id}
                      className={`dot${prefs.cardBackColour === c.id ? ' dot--on' : ''}`}
                      aria-label={c.name}
                      aria-pressed={prefs.cardBackColour === c.id}
                      style={{ ['--dot-colour' as string]: `var(--card-back-${c.id})` }}
                      onClick={() => setPref({ cardBackColour: c.id })}
                    />
                  ))}
                </div>
              </>
            )}

            {pane === 'chips' && (
              <>
                <p className="settings__lede">
                  <strong>Everyone at the table sees these.</strong> That is deliberate — a
                  cosmetic nobody else sees is not worth choosing. It is also useful: your colour
                  is how people tell your bets apart from everyone else's.
                </p>

                <p className="settings__lede">Colour</p>
                <div className="dotRow">
                  {CHIP_COLOURS.map((c) => (
                    <button
                      key={c.id}
                      className={`chipPick${skin.chipColour === c.id ? ' chipPick--on' : ''}`}
                      aria-label={c.name}
                      aria-pressed={skin.chipColour === c.id}
                      onClick={() => applySkin({ ...skin, chipColour: c.id })}
                    >
                      <ChipStack amount={1} skin={{ chipStyle: skin.chipStyle, chipColour: c.id }} />
                    </button>
                  ))}
                </div>

                <div className="swatches">
                  {CHIP_STYLES.map((s) => (
                    <button
                      key={s.id}
                      className={`swatch${skin.chipStyle === s.id ? ' swatch--on' : ''}`}
                      aria-pressed={skin.chipStyle === s.id}
                      onClick={() => applySkin({ ...skin, chipStyle: s.id })}
                    >
                      <span className="swatch__cards" aria-hidden>
                        <ChipStack
                          amount={130}
                          skin={{ chipStyle: s.id, chipColour: skin.chipColour }}
                        />
                      </span>
                      <span className="swatch__text">
                        <span className="swatch__name">{s.name}</span>
                        <span className="swatch__desc">{s.desc}</span>
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
