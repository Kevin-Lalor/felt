import type { ClientMessage, ServerMessage } from '@poker/protocol';
import { serverMessageSchema } from '@poker/protocol';
import { useStore } from './store';

let socket: WebSocket | null = null;
let joinPayload: ClientMessage | null = null;
let reconnectDelay = 500;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function connectAndJoin(input: { inviteCode: string; name: string; avatar: number }): void {
  const token = localStorage.getItem('felt.playerToken') ?? undefined;
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
  if (socket) socket.close();
  socket = new WebSocket(wsUrl());
  const store = useStore.getState();

  socket.onopen = () => {
    reconnectDelay = 500;
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
  };
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    if (joinPayload) {
      setTimeout(open, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }
  };
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
