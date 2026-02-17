# Multi-Platform Roadmap (Design)
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo currently ships a production WhatsApp runtime and local demo runtimes for Slack/Discord adapter verification.

This doc captures the intended architecture for supporting multiple messaging platforms while:

- preserving per-platform safety/guardrails
- allowing separate personas per platform
- keeping the setup wizard coherent

## Goals

- Keep platform adapters explicit and pluggable without rewriting feature handlers.
- Prioritize official-platform adapter paths (Slack/Teams) for commercial use-cases.
- Treat WhatsApp via Baileys as community/self-hosted best-effort unless and until an official WhatsApp platform adapter is added.

## Unified Identity Mapping (Design)

Before building any WhatsApp<->Discord relay, implement a stable identity map keyed by platform+user IDs.

Proposed model:

- `member_identity_map` table (or equivalent service)
- columns:
  - `canonical_member_id` (internal stable id)
  - `platform` (`whatsapp` | `discord` | `slack`)
  - `platform_user_id`
  - `verified_at` (nullable)
  - `link_method` (`owner_verified` | `self_claim_code`)

Guardrails:

- Never auto-link users solely by display name.
- Require owner approval or explicit user proof flow.
- Keep an audit trail for links/unlinks.

## Bridge Safety Primitives (Required Before Relay)

Define these as core invariants before enabling any WA<->Discord message forwarding:

1. **Loop prevention**
   - every bridged message carries `bridge_origin` metadata
   - adapters ignore messages whose origin matches destination bridge pair

2. **Idempotency and dedupe**
   - store `(bridge_pair_id, source_message_id)` with TTL
   - skip duplicates on retries/reconnects

3. **Attribution format**
   - normalized sender label: `<display_name> [platform]`
   - include source deep-link/reference when supported

4. **Rate and failure controls**
   - per-bridge send rate limits
   - dead-letter queue + owner-visible failure summaries

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
