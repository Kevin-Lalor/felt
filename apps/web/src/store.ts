import { create } from 'zustand';
import type { ServerMessage, TableView } from '@poker/protocol';
import { applyPrefs, loadPrefs, savePrefs } from './prefs';
import type { Prefs } from './prefs';

export type ChatLine = {
  kind: 'chat' | 'emote' | 'system' | 'dealer';
  from: string;
  /** Seat of the player who spoke, or null when on the rail / the dealer. */
  seat: number | null;
  text: string;
  at: number;
};

export type ChipLogEntry = { at: number; playerName: string; delta: number; reason: string };

type Store = {
  phase: 'join' | 'table';
  connected: boolean;
  playerId: string | null;
  isHost: boolean;
  tableName: string;
  view: TableView | null;
  chat: ChatLine[];
  chipLog: ChipLogEntry[];
  lastError: { code: string; message: string; at: number } | null;
  lastCommit: { handNumber: number; commit: string } | null;
  lastReveal: { handNumber: number; serverSeed: string; commit: string } | null;
  awards: { seat: number; amount: number; label?: string; at: number }[];
  showdownThisHand: boolean;
  /** Your own hole cards, by the commitment of the hand they were dealt in.
   *  Mucked hands are not in the public history (HOUSE-RULES #16), so this is
   *  how you can still see — and check — what you folded. Your data, kept on
   *  your device; the server sends nothing extra for it. */
  myHands: Record<string, { seat: number; cards: string[] }>;
  /** Local display preferences. Never sent to the server. */
  prefs: Prefs;
  setPref: (patch: Partial<Prefs>) => void;
  applyServerMessage: (msg: ServerMessage) => void;
  setConnected: (connected: boolean) => void;
  reset: () => void;
};

export const useStore = create<Store>((set, get) => ({
  phase: 'join',
  connected: false,
  playerId: null,
  isHost: false,
  tableName: '',
  view: null,
  chat: [],
  chipLog: [],
  lastError: null,
  lastCommit: null,
  lastReveal: null,
  awards: [],
  showdownThisHand: false,
  myHands: loadMyHands(),
  prefs: loadPrefs(),

  setPref: (patch) => {
    const next = { ...get().prefs, ...patch };
    applyPrefs(next);
    savePrefs(next);
    set({ prefs: next });
  },

  setConnected: (connected) => set({ connected }),
  reset: () => set({ phase: 'join', view: null, playerId: null }),

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'welcome':
        localStorage.setItem('felt.playerToken', msg.playerToken);
        set({ phase: 'table', playerId: msg.playerId, isHost: msg.isHost, tableName: msg.tableName });
        break;
      case 'state': {
        set({ view: msg.view });
        const commit = msg.view.fairness?.commit;
        const seat = msg.view.yourSeat;
        const cards = seat === null ? undefined : msg.view.seats[seat]?.holeCards;
        if (commit && seat !== null && cards?.length === 2 && !get().myHands[commit]) {
          const myHands = { ...get().myHands, [commit]: { seat, cards: [...cards] } };
          set({ myHands });
          saveMyHands(myHands);
        }
        break;
      }
      case 'chat':
        set({ chat: [...get().chat.slice(-199), { kind: 'chat', from: msg.from, seat: msg.seat, text: msg.text, at: msg.at }] });
        break;
      case 'emote':
        set({
          chat: [
            ...get().chat.slice(-199),
            { kind: 'emote', from: msg.from, seat: msg.seat, text: msg.emote, at: msg.at },
          ],
        });
        break;
      case 'chipLog':
        set({ chipLog: msg.entries });
        break;
      case 'error':
        set({ lastError: { code: msg.code, message: msg.message, at: Date.now() } });
        break;
      case 'handCommit':
        set({
          lastCommit: { handNumber: msg.handNumber, commit: msg.commit },
          awards: [],
          showdownThisHand: false,
          chat: [
            ...get().chat.slice(-199),
            {
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `hand #${msg.handNumber} — shuffle committed ${msg.commit.slice(0, 12)}…`,
              at: Date.now(),
            },
          ],
        });
        break;
      case 'handReveal':
        set({
          lastReveal: { handNumber: msg.handNumber, serverSeed: msg.serverSeed, commit: msg.commit },
          chat: [
            ...get().chat.slice(-199),
            {
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `hand #${msg.handNumber} — server seed revealed. Verify it on the Fair tab.`,
              at: Date.now(),
            },
          ],
        });
        break;
      case 'events': {
        const lines: ChatLine[] = [];
        const awards = [...get().awards];
        for (const e of msg.events) {
          if (e.t === 'showdown') set({ showdownThisHand: true });
          if (e.t === 'acted' && e.seat !== undefined && e.action) {
            const verb =
              e.action.kind === 'bet' || e.action.kind === 'raise'
                ? `${e.action.kind}s to ${e.action.to}`
                : e.action.kind === 'allIn'
                  ? 'is ALL IN'
                  : `${e.action.kind}s`;
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `seat ${(e.seat ?? 0) + 1} ${verb}`,
              at: Date.now(),
            });
          }
          if (e.t === 'handKilled' && e.seat !== undefined) {
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `seat ${e.seat + 1} was removed by the host — that hand is dead`,
              at: Date.now(),
            });
          }
          if (e.t === 'betReturned' && e.seat !== undefined && e.amount !== undefined) {
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `seat ${e.seat + 1} gets ${e.amount} back — nobody still in the hand matched it`,
              at: Date.now(),
            });
          }
          if (e.t === 'streetDealt' && e.cards) {
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `${e.street}: ${e.cards.join(' ')}`,
              at: Date.now(),
            });
          }
          if (e.t === 'potAwarded' && e.seat !== undefined && e.amount !== undefined) {
            awards.push({ seat: e.seat, amount: e.amount, at: Date.now(), ...(e.label ? { label: e.label } : {}) });
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              seat: null,
              text: `seat ${e.seat + 1} wins ${e.amount}${e.label ? ` with ${e.label}` : ''}`,
              at: Date.now(),
            });
          }
        }
        if (lines.length > 0) set({ chat: [...get().chat.slice(-190), ...lines] });
        set({ awards });
        break;
      }
    }
  },
}));

const MY_HANDS_KEY = 'felt.myHands';
/** As many as the history API serves. */
const MY_HANDS_KEPT = 200;

function loadMyHands(): Record<string, { seat: number; cards: string[] }> {
  try {
    const raw = localStorage.getItem(MY_HANDS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { seat: number; cards: string[] }>) : {};
  } catch {
    return {};
  }
}

function saveMyHands(hands: Record<string, { seat: number; cards: string[] }>): void {
  const kept = Object.fromEntries(Object.entries(hands).slice(-MY_HANDS_KEPT));
  try {
    localStorage.setItem(MY_HANDS_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the record is a convenience, not the proof.
  }
}
