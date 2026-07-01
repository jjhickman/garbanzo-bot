import type { WASocket } from '@whiskeysockets/baileys';
// @ts-expect-error — qrcode-terminal has no type declarations
import qrcode from 'qrcode-terminal';

export type LoginMode = 'web' | 'terminal' | 'both';
export type LoginLinkState = 'pending' | 'linked';
export interface LoginSnapshot { state: LoginLinkState; qr: string | null; }

type LoginSubscriber = (snapshot: LoginSnapshot) => void;

let state: LoginLinkState = 'pending';
let qr: string | null = null;
let activeSocket: WASocket | null = null;
const subscribers = new Set<LoginSubscriber>();

function notify(): void {
  const snapshot = getSnapshot();
  for (const subscriber of subscribers) {
    try {
      subscriber(snapshot);
    } catch {
      // Keep one bad listener from preventing other login observers from updating.
    }
  }
}

export function routeLoginQr(nextQr: string, mode: LoginMode): void {
  if (mode === 'terminal' || mode === 'both') {
    qrcode.generate(nextQr, { small: true });
  }

  if (mode === 'web' || mode === 'both') {
    publishQr(nextQr);
  }
}

export function publishQr(nextQr: string): void {
  qr = nextQr;
  state = 'pending';
  notify();
}

export function markLinked(): void {
  qr = null;
  state = 'linked';
  notify();
}

export function markUnlinked(): void {
  qr = null;
  state = 'pending';
  notify();
}

export function getSnapshot(): LoginSnapshot {
  return { state, qr };
}

export function subscribe(fn: LoginSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function setActiveSocket(sock: WASocket | null): void {
  activeSocket = sock;
}

export function getActiveSocket(): WASocket | null {
  return activeSocket;
}

export function __resetLoginStore(): void {
  qr = null;
  state = 'pending';
  activeSocket = null;
  subscribers.clear();
}
