# Platforms

This directory will hold platform-specific runtimes and adapters.

Today:

- WhatsApp is supported via Baileys (`src/platforms/whatsapp/runtime.ts`).

Future:

- Slack/Teams should be built on official APIs.
- Each platform should be a thin adapter that normalizes inbound messages and calls core routing.
