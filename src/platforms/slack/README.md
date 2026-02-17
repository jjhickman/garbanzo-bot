# Slack Runtime
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Slack runtime now supports two modes:

1. Official Events API mode (production):
   - Requires `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`
   - Starts HTTP endpoint at `/slack/events`
   - Uses Slack signature verification

2. Demo mode (local testing):
   - Set `SLACK_DEMO=true`
   - Starts HTTP health endpoints at `/slack/demo` and `/discord/demo`
   - Starts unified chat endpoint at `/demo/chat` (`{"platform":"slack|discord","text":"..."}`)
   - Accepts synthetic payloads for pipeline verification

Implementation notes:

- Inbound payloads normalize to `src/core/inbound-message.ts`.
- Message sends use Slack Web API (`chat.postMessage`, `files.upload`, `chat.delete`).
- Mention invocation supports `<@BOT_USER_ID>` patterns and `@garbanzo` fallback.
