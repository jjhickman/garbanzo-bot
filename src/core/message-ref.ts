/**
 * Opaque message reference.
 *
 * Each platform can return whatever it needs to later delete or reply to a message.
 * Core treats this as an opaque value.
 */
export type MessageRef = unknown;
