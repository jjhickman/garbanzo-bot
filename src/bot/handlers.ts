// WhatsApp-specific handler implementation lives in the WhatsApp platform folder.
// We keep this re-export for backwards compatibility inside the codebase.
export { registerWhatsAppHandlers as registerHandlers } from '../platforms/whatsapp/handlers.js';
