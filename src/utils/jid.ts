/**
 * WhatsApp JID utilities
 */

/** Check if a JID is a group (ends with @g.us) */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** Check if a JID is a direct message (ends with @s.whatsapp.net) */
export function isDmJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net');
}

/** Check if a JID is a WhatsApp LID (privacy alias, ends with @lid) */
export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

/**
 * Strip the device suffix from a user JID: `1234:17@s.whatsapp.net` →
 * `1234@s.whatsapp.net`. Multi-device senders arrive with a per-device
 * suffix, so raw string equality against a configured JID fails.
 */
export function bareUserJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0];
  return `${user}${jid.slice(at)}`;
}

/**
 * Compare two user identifiers, tolerating device suffixes on either side.
 * Non-JID platform IDs (no `@`) degrade to plain equality.
 */
export function jidsMatch(a: string, b: string): boolean {
  return bareUserJid(a) === bareUserJid(b);
}

/** Extract the phone number from a user JID */
export function phoneFromJid(jid: string): string {
  return jid.split('@')[0];
}

/** Normalize a phone number to a JID */
export function phoneToJid(phone: string): string {
  const cleaned = phone.replace(/[^0-9]/g, '');
  return `${cleaned}@s.whatsapp.net`;
}

/** Get sender JID from a message, handling group messages */
export function getSenderJid(
  remoteJid: string,
  participant?: string | null,
): string {
  if (isGroupJid(remoteJid) && participant) {
    return participant;
  }
  return remoteJid;
}
