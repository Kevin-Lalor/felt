import { useEffect, useRef, useState } from 'react';
import { send } from '../socket';
import { useStore } from '../store';

type Tab = 'chat' | 'log' | 'fair' | 'hands';

type HistoryHand = {
  handNumber: number;
  at: string;
  board: string[];
  seats: { seat: number; name: string; holeCards: string[]; stackAfter: number }[];
  commit: string;
  serverSeed: string;
};

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
  const fairness = view?.fairness ?? null;

  return (
    <div className="rail__body rail__body--scroll">
      <p className="rail__note">
        Before every deal the server publishes a hash of its secret seed. The deck is derived from
        that seed <em>plus a seed from every player</em> — so nobody, including the host, can
        pre-compute the shuffle. After the hand the seed is revealed and anyone can re-derive the
        whole deck.
      </p>
      {fairness && (
        <>
          <p className="rail__mono">COMMIT (hand #{view?.handNumber})</p>
          <p className="rail__hash">{fairness.commit}</p>
          <p className="rail__mono">PLAYER SEEDS IN THE SHUFFLE</p>
          {Object.entries(fairness.clientSeeds).map(([name, s]) => (
            <p key={name} className="chat__line">
              <span className="chat__from">{name}</span>
              {s}
            </p>
          ))}
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
            send({ type: 'setClientSeed', seed: s });
          }}
        >
          Set
        </button>
      </div>
      <p className="rail__note">
        Change it any time — it takes effect next hand. To verify a finished hand offline, download{' '}
        <a href="/api/history" target="_blank" rel="noreferrer">the hand history</a> and run{' '}
        <code>pnpm verify-hand &lt;hand#&gt;</code> from the repo.
      </p>
    </div>
  );
}

function HandsTab() {
  const [hands, setHands] = useState<HistoryHand[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetch('/api/history')
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
        <div key={hand.handNumber} className="handCard">
          <p className="chat__line">
            <span className="chat__from">#{hand.handNumber}</span>
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
