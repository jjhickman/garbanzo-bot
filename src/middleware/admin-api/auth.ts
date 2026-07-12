import { timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function authorityHostname(authority: string): string | undefined {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function requestHasAllowedHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && ALLOWED_HOSTNAMES.has(authorityHostname(host) ?? '');
}

export function requestHasAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  try {
    return ALLOWED_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function requestHasValidAdminBearer(req: IncomingMessage, expectedToken: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match) return false;

  const presented = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
