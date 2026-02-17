# Promotion Snippets
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Use these short posts when announcing Garbanzo updates.

## Launch Post (General)

Garbanzo is now positioned as an AI chat operations platform for communities and small teams.

- Multi-provider routing: Claude, OpenAI, Gemini, OpenRouter, and optional local Ollama
- Built-in workflows: summaries, event planning, moderation signals, recommendations
- Integration-ready commands: weather, transit, venues, news, books, and D&D utilities
- Docker-first self-hosted deployment with health/readiness guardrails

Repo: https://github.com/jjhickman/garbanzo-bot
Website: https://garbanzobot.com

## Technical Post (Engineer Audience)

If you need AI in group chat without vendor lock-in, Garbanzo runs provider-orchestrated routing with configurable `AI_PROVIDER_ORDER` and model overrides.

- Cloud failover across Claude/OpenAI/Gemini/OpenRouter
- Optional local Ollama for low-cost/simple prompt routing
- Operational controls: retries, rate limits, backup integrity, `/health` + `/health/ready`

Quick start: clone, `npm run setup`, `docker compose up -d`.

## Feature Post (Community Operators)

Garbanzo helps busy groups move from noise to action:

- `!summary` and `!catchup` for fast context
- Event planning with transit + weather enrichment
- Member-safe release updates with preview-before-send controls
- Owner digests and moderation signals for safer operations

Designed for active communities and small teams that need useful AI workflows, not chatbot gimmicks.

## 30-Second Demo Outline

1. Show mention-driven prompt (`@garbanzo !summary`).
2. Show enriched event planning response (weather/transit context).
3. Show provider routing config snippet (`AI_PROVIDER_ORDER=...`).
4. Show `curl /health/ready` operational check.
5. End with repo + Docker Hub URLs.
