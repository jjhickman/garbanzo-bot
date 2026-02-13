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
