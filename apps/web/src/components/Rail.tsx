import { useEffect, useRef, useState } from 'react';
import { EMOTES } from '@poker/protocol';
import { send } from '../socket';
import { useStore } from '../store';

type Tab = 'chat' | 'log' | 'fair' | 'hands' | 'host';

type HistoryHand = {
  handId?: string;
  handNumber: number;
  at: string;
  board: string[];
  /** Each card is null when it was mucked (HOUSE-RULES #16) — the server never
   *  sends it, so there is nothing here to hide. */
  seats: { seat: number; name: string; holeCards: (string | null)[]; stackAfter: number }[];
  commit: string;
  serverSeed: string;
};

/** The history routes are gated on the same code as the socket. It travels in
 *  a header, never the URL — a URL ends up in server logs, browser history and
 *  Referer headers, and the code is the key to the table. */
function fetchHistory(): Promise<Response> {
  const code = localStorage.getItem('felt.inviteCode') ?? '';
  return fetch('/api/history', { headers: { 'x-felt-code': code } });
}

/** A plain link cannot carry a header, so the download is fetched and handed
 *  to the browser as a file. */
async function downloadHistory(): Promise<void> {
  const response = await fetchHistory();
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'felt-hand-history.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** Who said it, and where they sit — a name alone can be copied, a seat can't.
 *  Seats are 1-based on the felt; a player not seated is on the rail. */
function speaker(from: string, seat: number | null): string {
  return seat === null ? `${from} · rail` : `${from} · seat ${seat + 1}`;
}

export function Rail() {
  const [tab, setTab] = useState<Tab>('chat');
  const [open, setOpen] = useState(false); // mobile sheet toggle
  const isHost = useStore((s) => s.isHost);
  const tabs: (readonly [Tab, string])[] = [
    ['chat', 'Chat'],
    ['log', 'Chips'],
    ['fair', 'Fair'],
    ['hands', 'Hands'],
    // Light host (HOUSE-RULES #13): remove and pause, nothing more. No
    // wireframe covers this tab; see docs/design/WIREFRAMES.md.
    ...(isHost ? [['host', 'Host'] as const] : []),
  ];

  return (
    <>
      <button className="railToggle" onClick={() => setOpen(!open)} aria-label="table talk">
        💬
      </button>
      <aside className={`rail${open ? ' rail--open' : ''}`}>
        <nav className="rail__tabs">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              className={`rail__tab${tab === key ? ' rail__tab--on' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab === 'chat' && <ChatTab />}
        {tab === 'log' && <ChipLogTab />}
        {tab === 'fair' && <FairTab />}
        {tab === 'hands' && <HandsTab />}
        {tab === 'host' && isHost && <HostTab />}
      </aside>
    </>
  );
}

function ChatTab() {
  const chat = useStore((s) => s.chat);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'nearest' }), [chat.length]);

  const say = () => {
    const text = draft.trim();
    if (text) send({ type: 'chat', text });
    setDraft('');
  };

  return (
    <div className="rail__body">
      <div className="chat">
        {chat.map((line, i) =>
          line.kind === 'dealer' ? (
            <p key={i} className="chat__dealer">{line.text}</p>
          ) : line.kind === 'emote' ? (
            <p key={i} className="chat__emote">
              {speaker(line.from, line.seat)} {line.text}
            </p>
          ) : (
            <p key={i} className="chat__line">
              <span className="chat__from">{speaker(line.from, line.seat)}</span>
              {line.text}
            </p>
          ),
        )}
        <div ref={bottom} />
      </div>
      <div className="chat__quick">
        {EMOTES.map((q) => (
          <button key={q} className="pill" onClick={() => send({ type: 'emote', emote: q })}>
            {q}
          </button>
        ))}
      </div>
      <div className="chat__composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && say()}
          placeholder="Say something…"
          maxLength={300}
        />
        <button className="btn btn--small" onClick={say}>↵</button>
      </div>
    </div>
  );
}

function ChipLogTab() {
  const chipLog = useStore((s) => s.chipLog);
  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__note">
        Every chip adjustment at this table, visible to everyone. Nothing hidden.
      </p>
      {chipLog.length === 0 && <p className="chat__dealer">No adjustments yet.</p>}
      {[...chipLog].reverse().map((entry, i) => (
        <p key={i} className="chat__line">
          <span className="chat__from">{entry.playerName}</span>
          {entry.delta > 0 ? `+${entry.delta}` : entry.delta} · {entry.reason}
        </p>
      ))}
    </div>
  );
}

function FairTab() {
  const view = useStore((s) => s.view);
  const reveal = useStore((s) => s.lastReveal);
  const [seed, setSeed] = useState(localStorage.getItem('felt.clientSeed') ?? '');
  const [pinned, setPinned] = useState(localStorage.getItem('felt.seedPinned') === '1');
  const fairness = view?.fairness ?? null;

  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__note">
        The server publishes the hash of the secret seed for the <em>next</em> hand as the current
        one starts — so your seed is always chosen after the commitment it goes into, and the host
        cannot pick a deck to suit itself. The deck comes from that seed plus a seed from every
        seated player. After the hand the seed is revealed and anyone can re-derive the whole deck.
      </p>
      {fairness && (
        <>
          <p className="rail__mono">COMMIT FOR THE NEXT HAND (#{fairness.nextHandNumber})</p>
          <p className="rail__hash">{fairness.nextCommit}</p>
          {fairness.commit && (
            <>
              <p className="rail__mono">COMMIT (hand #{fairness.handNumber})</p>
              <p className="rail__hash">{fairness.commit}</p>
            </>
          )}
          {fairness.clientSeeds.length > 0 && (
            <>
              <p className="rail__mono">PLAYER SEEDS IN THIS SHUFFLE</p>
              {fairness.clientSeeds.map((s) => (
                <p key={s.seat} className="chat__line">
                  <span className="chat__from">{s.name}</span>
                  {s.seed} {s.postCommit ? '✓' : '· set before the commit'}
                </p>
              ))}
            </>
          )}
          {fairness.revealedServerSeed && (
            <>
              <p className="rail__mono">REVEALED SERVER SEED</p>
              <p className="rail__hash">{fairness.revealedServerSeed}</p>
            </>
          )}
        </>
      )}
      {reveal && !fairness?.revealedServerSeed && (
        <>
          <p className="rail__mono">LAST REVEAL (hand #{reveal.handNumber})</p>
          <p className="rail__hash">{reveal.serverSeed}</p>
        </>
      )}
      <p className="rail__mono">YOUR SHUFFLE SEED</p>
      <div className="chat__composer">
        <input value={seed} onChange={(e) => setSeed(e.target.value)} maxLength={64} />
        <button
          className="btn btn--small"
          onClick={() => {
            const s = seed.trim();
            if (!s) return;
            localStorage.setItem('felt.clientSeed', s);
            localStorage.setItem('felt.seedPinned', '1');
            setPinned(true);
            send({ type: 'setClientSeed', seed: s });
          }}
        >
          Pin
        </button>
      </div>
      <p className="rail__note">
        {pinned ? (
          <>
            Your seed is pinned, so it stays the same every hand. That is fine, but a seed the
            server already knew when it committed does not constrain it —{' '}
            <button
              className="pill"
              onClick={() => {
                localStorage.removeItem('felt.seedPinned');
                setPinned(false);
              }}
            >
              use a fresh seed each hand
            </button>{' '}
            for the full guarantee.
          </>
        ) : (
          <>A fresh random seed is generated for you every hand, after the commitment is published. Pin one of your own if you prefer.</>
        )}
      </p>
      <p className="rail__note">
        Folded a hand? The Hands tab shows what you held, from your own device. To check it
        against the shuffle, run <code>pnpm verify-hand &lt;handId&gt; --seat &lt;your seat&gt;</code>.
        To verify a finished hand offline, download{' '}
        <button className="pill" onClick={() => void downloadHistory()}>
          the hand history
        </button>{' '}
        and run{' '}
        <code>pnpm verify-hand &lt;handId&gt;</code> from the repo.
      </p>
    </div>
  );
}

function HandsTab() {
  const myHands = useStore((s) => s.myHands);
  const [hands, setHands] = useState<HistoryHand[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetchHistory()
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data: HistoryHand[]) => setHands(data.reverse()))
      .catch(() => setError(true));
  }, []);

  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__note">
        Every finished hand, with every card that was shown down or shown by choice. Mucked hands
        stay hidden.
      </p>
      {error && <p className="chat__dealer">Could not load history.</p>}
      {hands.length === 0 && !error && <p className="chat__dealer">No hands yet.</p>}
      {hands.map((hand) => (
        <div key={hand.handId ?? hand.handNumber} className="handCard">
          <p className="chat__line">
            <span className="chat__from">{hand.handId ?? `#${hand.handNumber}`}</span>
            board {hand.board.join(' ') || '(no flop)'}
          </p>
          {hand.seats.map((s) => {
            const mine = myHands[hand.commit];
            const yours = mine?.seat === s.seat ? mine.cards : null;
            return (
              <p key={s.seat} className="chat__dealer">
                {s.name}: {shownCards(s.holeCards)}
                {/* Only you see this line: it comes from your own device. */}
                {yours && s.holeCards.some((c) => c === null) && ` (you held ${yours.join(' ')})`} →{' '}
                {s.stackAfter}
              </p>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** "As Kd", "As ··" for one card shown, or "mucked". */
function shownCards(cards: (string | null)[]): string {
  if (cards.every((c) => c === null)) return 'mucked';
  return cards.map((c) => c ?? '··').join(' ');
}

/** Light host (HOUSE-RULES #13–#15): pause dealing, remove a player. */
function HostTab() {
  const view = useStore((s) => s.view);
  const me = useStore((s) => s.playerId);
  const [removing, setRemoving] = useState<{ playerId: string; name: string } | null>(null);
  if (!view) return null;
  const others = view.players.filter((p) => p.playerId !== me);

  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__mono">DEALING</p>
      <button
        className="btn btn--small"
        onClick={() => send({ type: 'setPaused', paused: !view.paused })}
      >
        {view.paused ? 'Resume dealing' : 'Pause dealing'}
      </button>
      <p className="rail__note">
        {view.paused
          ? 'Paused. No new hand is dealt until you resume. Chat and sitting out still work.'
          : 'Pausing lets the hand in progress finish on its normal clocks, then deals nothing until you resume.'}
      </p>

      <p className="rail__mono">PLAYERS</p>
      {others.length === 0 && <p className="chat__dealer">Nobody else is here yet.</p>}
      {others.map((p) => (
        <p key={p.playerId} className="chat__line">
          <span className="chat__from">
            {p.name} · {p.seat === null ? 'rail' : `seat ${p.seat + 1}`}
            {p.connected ? '' : ' · away'}
          </span>{' '}
          {p.removeAfterHand ? (
            <span className="pill pill--warn">Leaving after this hand</span>
          ) : (
            <button className="pill" onClick={() => setRemoving({ playerId: p.playerId, name: p.name })}>
              Remove
            </button>
          )}
        </p>
      ))}

      {removing && (
        <div className="modalScrim" onClick={() => setRemoving(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">Remove {removing.name}?</h2>
            <p className="rail__note">
              If they are in a hand, it is folded now, and the chips they have already put in stay
              in the pot — except any that nobody still in the hand has called, which go back to
              them. Their stack leaves the table, and the chip log shows it as removed by host.
              If you are both still in the hand, they are removed when it ends instead.
            </p>
            <p className="rail__note">
              <strong>This is not a ban.</strong> It only stops this device rejoining until the
              server restarts, and they can join again as a new player with the invite code. To
              keep them out, remove their email from the Cloudflare Access allowlist, and change
              the invite code if they might have it.
            </p>
            <button
              className="btn btn--accent"
              onClick={() => {
                send({ type: 'kick', playerId: removing.playerId });
                setRemoving(null);
              }}
            >
              Remove {removing.name}
            </button>
            <button className="btn btn--ghost" onClick={() => setRemoving(null)}>
              Keep them
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
