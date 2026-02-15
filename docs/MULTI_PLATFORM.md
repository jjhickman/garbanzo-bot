# Multi-Platform Roadmap (Design)

Garbanzo is WhatsApp-first today.

This doc captures the intended architecture for supporting multiple messaging platforms while:

- preserving per-platform safety/guardrails
- allowing separate personas per platform
- keeping the setup wizard coherent

## Goals

- Add official-platform adapters first (Slack/Teams) for enterprise viability.
- Treat WhatsApp via Baileys as community/self-hosted best-effort.
- Make platform adapters pluggable without rewriting features.

## Transport Adapter Interface

Each platform adapter should implement a small surface:

- receive inbound messages -> normalized internal message type
- send text replies
- provide identity primitives (user id, channel id, display names)

## Persona per Platform

We want a separate persona per platform because:

- tone expectations differ (Slack workspaces vs WhatsApp friend groups)
- privacy expectations differ (corporate policies)
- moderation posture differs

Proposed config:

- `PERSONA.md` remains the default.
- Optional overrides:
  - `docs/personas/whatsapp.md`
  - `docs/personas/slack.md`
  - `docs/personas/discord.md`

Resolution:

- if platform persona exists, use it
- else fall back to `docs/PERSONA.md`
- group personas (from `config/groups.json`) are applied last as an addendum

## Setup Wizard Changes

Add prompts/flags:

- `--platform=whatsapp|slack|discord|teams`
- `--persona-platform-file=./path/to/slack.md` (optional)

Wizard behavior:

- Copies the selected persona file into `docs/personas/<platform>.md`
- Keeps `docs/PERSONA.md` as the general fallback

## Security & Privacy Considerations

- Platform adapters must not auto-execute tools or webhooks based on untrusted input.
- Each adapter should have rate limiting and mention gating semantics that match the platform.
- For enterprise platforms, add audit logs for admin actions.

## Recommended Platform Order

1) Slack (official, straightforward API, clear security model)
2) Teams (official but more complex app registration)
3) Discord (popular, but less enterprise driven)
4) Official WhatsApp Business Platform adapter (separate onboarding)
