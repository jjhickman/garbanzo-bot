# ADR-0001: WhatsApp Outbound Safety

- Status: Accepted
- Date: 2026-05-27
- Scope: WhatsApp runtime only

## Context

Garbanzo uses Baileys for a personal WhatsApp account. WhatsApp is the primary
runtime for this deployment, and the account-risk tradeoff is accepted, but
automated welcomes, introductions, digests, and release sends must remain
controlled and recoverable.

The reviewed `baileys-antiban` package offers useful rate, warm-up, risk, and
disconnect-classification logic. Its queue persistence is not sufficient for
Garbanzo's Docker restart and manual-release requirements.

## Decision

1. Pin `baileys-antiban` to `3.9.0` and use only `AntiBan` risk/send decisions
   and `classifyDisconnect`.
2. Wrap the WhatsApp socket once at connection startup so every WhatsApp
   `sendMessage` call passes through a single outbound dispatcher.
3. Store outbound jobs and safety state in Garbanzo's SQLite/Postgres backend.
   Jobs blocked by pause, warm-up, or rate/risk decisions enter `held` state.
4. Provide owner-only `!whatsapp` commands for status, pause, resume, list,
   explicit release, and discard. Owner control responses bypass a paused
   outbound dispatcher so control remains possible.
5. Preserve established features; they are queued/held by safety policy rather
   than removed.
6. Treat incoming-message inactivity as informational. A quiet group alone
   does not trigger a forced reconnect.

## Excluded Middleware Features

Garbanzo does not enable content mutation, automatic replies, proxy rotation,
fingerprint changes, stealth connection behavior, or third-party webhooks from
`baileys-antiban`.

## Consequences

- Docker restarts retain blocked/interrupted WhatsApp output for explicit owner
  handling.
- WhatsApp sends can be delayed or held during warm-up and elevated-risk
  periods; this is intentional.
- Slack and Discord behavior is unchanged.
- `baileys-antiban` warm-up state uses a state file inside the existing
  persisted `data` volume, while Garbanzo's database remains authoritative for
  job retention and operator controls.

### Follow-on hardening (PR #164 continuation)

- The prior bot-flag was traced to reconnect-lifecycle bugs (zombie sockets +
  stacking timers), not QR-refresh frequency; the reconnect path now enforces a
  single live socket per account and disposes per-generation timers/listeners.
- Account linking moved to a token-gated browser page (`WHATSAPP_LOGIN_MODE`,
  default `web`); QR rotation within one attempt is not a reconnect and is safe.
  See `docs/_internal/archive/IMPROVEMENTS.md` for the historical audit record.

## Deployment Gate

Deployment and QR/account linking must not proceed until the dedicated phone
number and WhatsApp account are prepared and the operator explicitly approves
rollout.
