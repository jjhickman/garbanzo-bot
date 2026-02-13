# Garbanzo Bot 🫘

A WhatsApp community bot for a 120+ member Boston-area meetup group, built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Claude AI.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and add your API keys
cp .env.example .env

# 3. Start in development mode (hot-reload)
npm run dev

# 4. Scan the QR code with WhatsApp when prompted
```

## What It Does

- Responds to `@garbanzo` mentions in WhatsApp group chats
- Routes questions to Claude (Anthropic) for intelligent responses
- Modular feature system: weather, transit, news, events (added incrementally)
- Runs on a local server (Terra) — self-hosted, no cloud dependencies

## Docs

- [PERSONA.md](docs/PERSONA.md) — Garbanzo's personality and voice
- [ROADMAP.md](docs/ROADMAP.md) — Phased implementation plan
- [SECURITY.md](docs/SECURITY.md) — Infrastructure security audit
- [INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) — Hardware and network reference

## Development

This project is designed to be developed with [OpenCode](https://opencode.ai). See [AGENTS.md](AGENTS.md) for coding agent instructions, and [opencode.json](opencode.json) for provider configuration.

```bash
npm run check     # typecheck + lint + test
npm run dev       # hot-reload development
npm run build     # compile TypeScript
npm run start     # production
```
