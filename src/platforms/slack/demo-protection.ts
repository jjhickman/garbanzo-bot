import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { logger } from '../../middleware/logger.js';
import { config } from '../../utils/config.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 30;
const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface TurnstileVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export type RateLimitEntry = {
  count: number;
  windowStartMs: number;
};

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }

  return req.socket.remoteAddress ?? 'unknown';
}

export function buildDemoSenderId(clientIp: string): string {
  const digest = createHash('sha256').update(clientIp).digest('hex').slice(0, 16);
  return `visitor-${digest}`;
}

export function allowRequest(rateLimit: Map<string, RateLimitEntry>, clientIp: string): boolean {
  const now = Date.now();
  const current = rateLimit.get(clientIp);

  if (!current || now - current.windowStartMs > RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(clientIp, { count: 1, windowStartMs: now });
    return true;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  current.count += 1;
  return true;
}

export function readTurnstileToken(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = (body as Record<string, unknown>).turnstileToken;
  if (typeof value !== 'string') return '';
  return value.trim();
}

export async function verifyTurnstileToken(token: string, clientIp: string): Promise<boolean> {
  const secret = config.DEMO_TURNSTILE_SECRET_KEY;
  if (!secret) {
    logger.error('Turnstile is enabled but DEMO_TURNSTILE_SECRET_KEY is missing');
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_VERIFY_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      remoteip: clientIp,
    });

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Turnstile verification endpoint returned non-200');
      return false;
    }

    const json = await response.json() as TurnstileVerifyResponse;
    if (json.success) return true;

    logger.warn({ errors: json['error-codes'] ?? [] }, 'Turnstile verification rejected token');
    return false;
  } catch (err) {
    logger.warn({ err }, 'Turnstile verification failed with network/error');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
