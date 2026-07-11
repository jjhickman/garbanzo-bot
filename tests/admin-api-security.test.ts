import type { IncomingMessage } from 'http';
import { describe, expect, it } from 'vitest';

import {
  requestHasAllowedHost,
  requestHasValidAdminBearer,
} from '../src/middleware/admin-api/auth.js';
import { createDeleteNonceStore } from '../src/middleware/admin-api/nonce-store.js';

function requestWithHeaders(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('admin API security primitives', () => {
  it('allows only loopback Host values with any port', () => {
    expect(requestHasAllowedHost(requestWithHeaders({ host: 'localhost:49152' }))).toBe(true);
    expect(requestHasAllowedHost(requestWithHeaders({ host: '127.0.0.1:3006' }))).toBe(true);
    expect(requestHasAllowedHost(requestWithHeaders({ host: '[::1]:3006' }))).toBe(true);
    expect(requestHasAllowedHost(requestWithHeaders({ host: 'evil.example' }))).toBe(false);
  });

  it('accepts only the exact bearer token', () => {
    const token = 'admin_test_token_1234';
    expect(requestHasValidAdminBearer(
      requestWithHeaders({ authorization: `Bearer ${token}` }),
      token,
    )).toBe(true);
    expect(requestHasValidAdminBearer(
      requestWithHeaders({ authorization: 'Bearer admin_test_token_1235' }),
      token,
    )).toBe(false);
    expect(requestHasValidAdminBearer(
      requestWithHeaders({ authorization: token }),
      token,
    )).toBe(false);
  });

  it('makes delete nonces single-use and rejects expiration', () => {
    let now = 1000;
    const store = createDeleteNonceStore(300_000, () => now);
    const first = store.issue(7);
    expect(store.consume(first.nonce, 7)).toBe('valid');
    expect(store.consume(first.nonce, 7)).toBe('invalid');

    const expiring = store.issue(8);
    now += 300_001;
    expect(store.consume(expiring.nonce, 8)).toBe('expired');
  });
});
