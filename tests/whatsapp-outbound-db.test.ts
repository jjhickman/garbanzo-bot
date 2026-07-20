process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../src/utils/db-schema.js';
import {
  createWhatsAppOutboundJob,
  getWhatsAppOutboundJob,
  updateWhatsAppOutboundJob,
} from '../src/utils/db-sqlite.js';

describe('WhatsApp outbound terminal payload storage', () => {
  beforeEach(() => {
    db.exec('DELETE FROM whatsapp_outbound_jobs;');
  });

  it('replaces sent and failed media JSON while leaving text JSON untouched', () => {
    const documentJson = JSON.stringify({ document: { type: 'Buffer', data: [1, 2, 3] } });
    const audioJson = JSON.stringify({ audio: { type: 'Buffer', data: [4, 5] } });
    const textJson = JSON.stringify({ text: 'hello' });
    const document = createWhatsAppOutboundJob('group@g.us', 'document', documentJson, null);
    const audio = createWhatsAppOutboundJob('group@g.us', 'audio', audioJson, null);
    const text = createWhatsAppOutboundJob('group@g.us', 'text', textJson, null);

    updateWhatsAppOutboundJob(
      document.id,
      'sent',
      null,
      123,
      JSON.stringify({ kind: 'document', strippedBytes: 3 }),
    );
    updateWhatsAppOutboundJob(
      audio.id,
      'failed',
      'send failed',
      null,
      JSON.stringify({ kind: 'audio', strippedBytes: 2 }),
    );
    updateWhatsAppOutboundJob(text.id, 'sent', null, 123);

    expect(JSON.parse(getWhatsAppOutboundJob(document.id)?.contentJson ?? '{}')).toEqual({
      kind: 'document',
      strippedBytes: 3,
    });
    expect(JSON.parse(getWhatsAppOutboundJob(audio.id)?.contentJson ?? '{}')).toEqual({
      kind: 'audio',
      strippedBytes: 2,
    });
    expect(getWhatsAppOutboundJob(text.id)?.contentJson).toBe(textJson);
  });
});
