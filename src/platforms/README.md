# Platforms

This directory will hold platform-specific runtimes and adapters.

Today:

- WhatsApp is supported via Baileys (`src/platforms/whatsapp/runtime.ts`).

Future:

- Slack/Teams should be built on official APIs.
- Each platform should normalize inbound messages to `src/core/inbound-message.ts`.
- Each platform can optionally override persona via `docs/personas/<platform>.md`.
