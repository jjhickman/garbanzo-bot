# Platforms
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


This directory will hold platform-specific runtimes and adapters.

Today:

- WhatsApp runtime is supported via Baileys (`src/platforms/whatsapp/runtime.ts`) for community/testing use.
- Slack runtime supports official Events API when `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` are configured.
- Discord runtime supports official interactions endpoint when `DISCORD_BOT_TOKEN` + `DISCORD_PUBLIC_KEY` are configured.
- Slack and Discord retain local demo modes for pipeline testing.

Next:

- Teams runtime remains a target adapter.
- Each platform normalizes inbound messages to `src/core/inbound-message.ts`.
- Platform-specific overrides can be layered without changing core routing.
