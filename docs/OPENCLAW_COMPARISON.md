# OpenClaw-Inspired Stack vs Garbanzo

This document compares:

- an OpenClaw-style "general personal assistant" approach (multi-channel, tool- and skill-heavy)
- Garbanzo's approach (curated community operations bot)

It is not a critique of upstream OpenClaw. OpenClaw is an impressive project with explicit security guidance and a broad feature surface.

## What OpenClaw Optimizes For

Based on OpenClaw's own documentation:

- many messaging channels (WhatsApp/Telegram/Slack/Discord/etc.)
- skills platform + registry
- automation (cron, webhooks)
- rich companion apps / control UI

Sources:

- OpenClaw README: https://github.com/openclaw/openclaw
- OpenClaw SECURITY: https://github.com/openclaw/openclaw/blob/main/SECURITY.md

## Common Pain Points People Report

Examples from community discussions include:

- setup complexity and brittleness
- unexpected cost spikes / rate limiting
- context window / memory management issues

Sources:

- Discussion example: https://github.com/openclaw/openclaw/discussions/4220
- Community runbook: https://github.com/digitalknk/openclaw-runbook

## Skill Ecosystem Tradeoff

OpenClaw has a public skills ecosystem. Community skills are powerful, but they increase the risk that:

- you install something insecure
- you pull in a large amount of unreviewed code

Source (disclaimer):

- Awesome OpenClaw Skills: https://github.com/VoltAgent/awesome-openclaw-skills

## What Garbanzo Optimizes For

Garbanzo is optimized for stable self-hosting and group chat coordination:

- mention-gated group behavior
- curated in-repo features (no arbitrary third-party skill marketplace execution)
- small HTTP surface (`/health` + `/health/ready`)
- local-first state (SQLite) and explicit backups
- CI guardrails (secrets scan + typecheck + lint + tests)

## Security and Privacy Posture (Default)

Garbanzo's default approach is intentionally narrow:

- fewer message surfaces (WhatsApp only today)
- fewer tool execution pathways
- fewer remote web UIs

This reduces attack surface for group deployments.

OpenClaw's guidance explicitly warns that its web interface is intended for local use and should not be exposed directly to the public internet.

Source:

- https://github.com/openclaw/openclaw/blob/main/SECURITY.md

## When to Choose Which

Pick an OpenClaw-style assistant when you want broad integrations, automation, and a skill ecosystem.

Pick Garbanzo when you want a smaller, auditable, group-ops bot with explicit guardrails and a low operational footprint.
