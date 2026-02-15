# Slack (planned)

This directory is reserved for the future Slack adapter/runtime.

Plan:

- Use Slack official APIs (Events API + Socket Mode) rather than unofficial transports.
- Normalize inbound messages to `src/core/inbound-message.ts`.
- Support a per-platform persona override via `docs/personas/slack.md`.
