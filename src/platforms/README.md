# Platforms
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This directory will hold platform-specific runtimes and adapters.

Today:

- WhatsApp runtime is supported via Baileys (`src/platforms/whatsapp/runtime.ts`) for community/testing use.
- Slack runtime supports official Events API when `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` are configured.
- Discord runtime supports official interactions endpoint when `DISCORD_BOT_TOKEN` + `DISCORD_PUBLIC_KEY` are configured.
- Slack and Discord retain local demo modes for pipeline testing.

Next:

- Telegram and Matrix runtimes are the next target adapters (enum groundwork
  landed first; the Microsoft Teams stub that used to be listed here was
  deleted — its SDK was archived January 2026 and it never had a working
  runtime).
- Each platform normalizes inbound messages to `src/core/inbound-message.ts`.
- Platform-specific overrides can be layered without changing core routing.
