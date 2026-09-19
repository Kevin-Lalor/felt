import { useEffect, useRef, useState } from 'react';
import { send } from '../socket';
import { useStore } from '../store';

type Tab = 'chat' | 'log' | 'fair' | 'hands';

type HistoryHand = {
  handId?: string;
  handNumber: number;
  at: string;
  board: string[];
  seats: { seat: number; name: string; holeCards: string[]; stackAfter: number }[];
  commit: string;
  serverSeed: string;
};

/** The history routes are gated on the same invite code as the socket. */
function historyUrl(): string {
  const code = localStorage.getItem('felt.inviteCode') ?? '';
  return `/api/history?code=${encodeURIComponent(code)}`;
}

export function Rail() {
  const [tab, setTab] = useState<Tab>('chat');
  const [open, setOpen] = useState(false); // mobile sheet toggle

  return (
    <>
      <button className="railToggle" onClick={() => setOpen(!open)} aria-label="table talk">
        💬
      </button>
      <aside className={`rail${open ? ' rail--open' : ''}`}>
        <nav className="rail__tabs">
          {(
            [
              ['chat', 'Chat'],
              ['log', 'Chips'],
              ['fair', 'Fair'],
              ['hands', 'Hands'],
            ] as const
          ).map(([key, label]) => (
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
            <p key={i} className="chat__emote">{line.from} {line.text}</p>
          ) : (
            <p key={i} className="chat__line">
              <span className="chat__from">{line.from}</span>
              {line.text}
            </p>
          ),
        )}
        <div ref={bottom} />
      </div>
      <div className="chat__quick">
        {['nh', 'ty', 'wow', 'lol', '🥶'].map((q) => (
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
        To verify a finished hand offline, download{' '}
        <a href={historyUrl()} target="_blank" rel="noreferrer">the hand history</a> and run{' '}
        <code>pnpm verify-hand &lt;handId&gt;</code> from the repo.
      </p>
    </div>
  );
}

function HandsTab() {
  const [hands, setHands] = useState<HistoryHand[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetch(historyUrl())
      .then((r) => r.json())
      .then((data: HistoryHand[]) => setHands(data.reverse()))
      .catch(() => setError(true));
  }, []);

  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__note">
        Full hand histories — hole cards included — become public the moment a hand ends.
        Transparency is the product.
      </p>
      {error && <p className="chat__dealer">Could not load history.</p>}
      {hands.length === 0 && !error && <p className="chat__dealer">No hands yet.</p>}
      {hands.map((hand) => (
        <div key={hand.handId ?? hand.handNumber} className="handCard">
          <p className="chat__line">
            <span className="chat__from">{hand.handId ?? `#${hand.handNumber}`}</span>
            board {hand.board.join(' ') || '(no flop)'}
          </p>
          {hand.seats.map((s) => (
            <p key={s.seat} className="chat__dealer">
              {s.name}: {s.holeCards.join(' ')} → {s.stackAfter}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
