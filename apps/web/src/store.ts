import { create } from 'zustand';
import type { ServerMessage, TableView } from '@poker/protocol';

export type ChatLine = {
  kind: 'chat' | 'emote' | 'system' | 'dealer';
  from: string;
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

  setConnected: (connected) => set({ connected }),
  reset: () => set({ phase: 'join', view: null, playerId: null }),

  applyServerMessage: (msg) => {
    switch (msg.type) {
      case 'welcome':
        localStorage.setItem('felt.playerToken', msg.playerToken);
        set({ phase: 'table', playerId: msg.playerId, isHost: msg.isHost, tableName: msg.tableName });
        break;
      case 'state':
        set({ view: msg.view });
        break;
      case 'chat':
        set({ chat: [...get().chat.slice(-199), { kind: 'chat', from: msg.from, text: msg.text, at: msg.at }] });
        break;
      case 'emote':
        set({
          chat: [
            ...get().chat.slice(-199),
            { kind: 'emote', from: msg.from, text: msg.emote, at: msg.at },
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
            lines.push({ kind: 'dealer', from: 'dealer', text: `seat ${(e.seat ?? 0) + 1} ${verb}`, at: Date.now() });
          }
          if (e.t === 'streetDealt' && e.cards) {
            lines.push({
              kind: 'dealer',
              from: 'dealer',
              text: `${e.street}: ${e.cards.join(' ')}`,
              at: Date.now(),
            });
          }
          if (e.t === 'potAwarded' && e.seat !== undefined && e.amount !== undefined) {
            awards.push({ seat: e.seat, amount: e.amount, at: Date.now(), ...(e.label ? { label: e.label } : {}) });
            lines.push({
              kind: 'dealer',
              from: 'dealer',
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
