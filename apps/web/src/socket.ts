import type { ClientMessage, ServerMessage } from '@poker/protocol';
import { serverMessageSchema } from '@poker/protocol';
import { useStore } from './store';

let socket: WebSocket | null = null;
let joinPayload: ClientMessage | null = null;
let reconnectDelay = 500;

/** Errors that mean "this join will never work as sent" — fix it and press Join
 *  again rather than reconnecting into the same refusal. */
const JOIN_REFUSALS = new Set([
  'badInvite',
  'tooManyAttempts',
  'badName',
  'tooManyConnections',
  'tooManyPlayers',
  'kicked',
]);

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function connectAndJoin(input: { inviteCode: string; name: string; avatar: number }): void {
  const token = localStorage.getItem('felt.playerToken') ?? undefined;
  // The history API is gated on the same code as the socket.
  localStorage.setItem('felt.inviteCode', input.inviteCode);
  let clientSeed = localStorage.getItem('felt.clientSeed');
  if (!clientSeed) {
    // The player's contribution to every shuffle. Random by default; change it
    // any time from the Fair tab — the server can never predict it.
    clientSeed = crypto.getRandomValues(new Uint32Array(4)).join('-');
    localStorage.setItem('felt.clientSeed', clientSeed);
  }
  joinPayload = {
    type: 'join',
    inviteCode: input.inviteCode,
    name: input.name,
    avatar: input.avatar,
    clientSeed,
    ...(token ? { playerToken: token } : {}),
  };
  open();
}

function open(): void {
  if (socket) {
    // Detach first: the old socket's close must not schedule a reconnect of
    // its own on top of this one.
    socket.onclose = null;
    socket.close();
  }
  socket = new WebSocket(wsUrl());
  const store = useStore.getState();

  socket.onopen = () => {
    reconnectDelay = 500;
    skinAnnounced = false; // re-announce after a reconnect
    useStore.getState().setConnected(true);
    if (joinPayload) socket?.send(JSON.stringify(joinPayload));
  };
  socket.onmessage = (raw) => {
    let parsed: ServerMessage;
    try {
      parsed = serverMessageSchema.parse(JSON.parse(String(raw.data)));
    } catch {
      return; // never act on a malformed frame
    }
    store.applyServerMessage(parsed);
    // A refused join must not be retried automatically. Reconnecting with the
    // same wrong code every few seconds would burn through the server's
    // wrong-code allowance and lock out everyone on this network.
    if (parsed.type === 'error' && JOIN_REFUSALS.has(parsed.code)) {
      joinPayload = null;
      // Removed by the host: back to the join screen, which shows why.
      if (parsed.code === 'kicked') useStore.getState().reset();
    }
    rotateSeedIfNeeded();
    announceSkinOnce(parsed);
  };
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    if (joinPayload) {
      setTimeout(open, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }
  };
}

/** A client seed only constrains the server if it was chosen AFTER the
 *  commitment it gets mixed into. The server publishes the next hand's
 *  commitment as the current hand starts, so rotating here means every hand is
 *  covered without the player having to remember to do anything. Players who
 *  pin a seed of their own opt out — the Fair tab shows them that. */
let rotatedAgainst: string | null = null;

function rotateSeedIfNeeded(): void {
  if (localStorage.getItem('felt.seedPinned') === '1') return;
  const fairness = useStore.getState().view?.fairness;
  if (!fairness) return;
  if (fairness.nextCommit === rotatedAgainst) return;
  rotatedAgainst = fairness.nextCommit;
  const seed = crypto.getRandomValues(new Uint32Array(4)).join('-');
  localStorage.setItem('felt.clientSeed', seed);
  send({ type: 'setClientSeed', seed });
}

/** A returning player's chip cosmetics are theirs; send them once the server
 *  has welcomed us. A player who has never picked sends nothing, so the
 *  server's join-time colour rotation stands. */
let skinAnnounced = false;

function announceSkinOnce(msg: ServerMessage): void {
  if (skinAnnounced || msg.type !== 'welcome') return;
  const skin = useStore.getState().prefs.skin;
  if (!skin) return;
  skinAnnounced = true;
  send({ type: 'setSkin', skin });
}

/** A phone that locks or switches apps often comes back with a socket that
 *  died while it was away, and the browser may not say so for a while. The
 *  server notices within a minute (its heartbeat) and sits you out; this makes
 *  the client notice the moment the page is looked at again, and rejoin. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !joinPayload) return;
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      reconnectDelay = 500;
      open();
    }
  });
}

export function send(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function leaveTable(): void {
  send({ type: 'leave' });
  joinPayload = null;
  socket?.close();
  useStore.getState().reset();
}
