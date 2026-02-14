import { readFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from '../utils/config.js';
import { truncate } from '../utils/formatting.js';

// Load persona at startup
const personaPath = resolve(PROJECT_ROOT, 'docs', 'PERSONA.md');
let personaDoc: string;
try {
  personaDoc = readFileSync(personaPath, 'utf-8');
} catch {
  logger.warn('PERSONA.md not found — using minimal system prompt');
  personaDoc = 'You are Garbanzo Bean, a WhatsApp community bot for a Boston meetup group. Be warm, direct, and helpful.';
}

export interface MessageContext {
  groupName: string;
  groupJid: string;
  senderJid: string;
  quotedText?: string;
}

/**
 * Build the system prompt for the AI model.
 * Keeps persona separate from routing/infrastructure concerns.
 */
export function buildSystemPrompt(ctx: MessageContext): string {
  return [
    personaDoc,
    '',
    '---',
    '',
    `You are currently in the "${ctx.groupName}" group chat.`,
    ctx.quotedText
      ? `The user is replying to this message: "${truncate(ctx.quotedText, 500)}"`
      : '',
    '',
    'Keep responses concise and use WhatsApp formatting (*bold*, _italic_, ~strike~).',
    'If you are unsure about something, say so honestly.',
  ]
    .filter(Boolean)
    .join('\n');
}
