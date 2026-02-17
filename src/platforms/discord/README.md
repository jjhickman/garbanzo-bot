# Discord Runtime
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Discord runtime supports two modes:

1. Official interactions mode (production):
   - Requires `DISCORD_BOT_TOKEN` and `DISCORD_PUBLIC_KEY`
   - Starts HTTP endpoint at `/discord/interactions`
   - Validates Discord interaction signatures

2. Demo mode (local testing):
   - Set `DISCORD_DEMO=true`
   - Starts HTTP endpoint at `/discord/demo`
   - Accepts synthetic payloads for pipeline verification

Implementation notes:

- Official mode currently processes slash-command interaction payloads and routes query text through core processing.
- Inbound payloads normalize to `src/core/inbound-message.ts`.
- Message sends use Discord REST API (`/channels/{id}/messages`).
