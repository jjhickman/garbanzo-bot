# Configuration

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MESSAGING_PLATFORM` | No | Messaging runtime target (`whatsapp`, `slack`, `discord`, `teams`) |
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` or `OPENAI_API_KEY` or `GEMINI_API_KEY` or `BEDROCK_MODEL_ID` | Yes | Cloud AI responses (Claude/OpenAI/Gemini/Bedrock failover) |
| `AI_PROVIDER_ORDER` | No | Comma-separated cloud provider priority (default: `openai,anthropic`) |
| `ANTHROPIC_MODEL` | No | Anthropic model override (default: `claude-haiku-4-5-20251001`) |
| `ANTHROPIC_PRICING_INPUT_PER_M` | No | Anthropic input pricing (USD per 1M tokens, for cost tracking; default `1.0` = Haiku 4.5) |
| `ANTHROPIC_PRICING_OUTPUT_PER_M` | No | Anthropic output pricing (USD per 1M tokens; default `5.0` = Haiku 4.5) |
| `ANTHROPIC_PROMPT_CACHING` | No | Mark the static persona system prompt cacheable so repeat calls read it at ~10% input price (default: `true`) |
| `OPENROUTER_MODEL` | No | OpenRouter model override (default: `anthropic/claude-sonnet-4-5`) |
| `OPENAI_MODEL` | No | OpenAI model override (default: `gpt-5.4-mini`; oauth mode uses a ChatGPT-backend slug) |
| `OPENAI_REASONING_EFFORT` | No | GPT-5/o-series reasoning depth on chat replies: `minimal`/`low`/`medium`/`high` (default: `low`; bounds hidden reasoning-token spend) |
| `OPENAI_PRICING_INPUT_PER_M` | No | OpenAI input pricing (USD per 1M tokens; default `0.75` = gpt-5.4-mini) |
| `OPENAI_PRICING_OUTPUT_PER_M` | No | OpenAI output pricing (USD per 1M tokens; default `4.5` = gpt-5.4-mini) |
| `OPENAI_AUTH_MODE` | No | `apikey` (default) or `oauth` ("Sign in with ChatGPT", experimental — see below) |
| `AI_TOOL_CALLING` | No | Enable native LLM tool calling for OpenRouter, Anthropic, and OpenAI API-key mode (default: `false`) |
| `AI_TOOL_MAX_ITERATIONS` | No | Max tool-call rounds per response, 1-5 (default: `3`) |
| `GEMINI_MODEL` | No | Gemini model override (default: `gemini-1.5-flash`) |
| `GEMINI_PRICING_INPUT_PER_M` | No | Gemini input pricing (USD per 1M tokens, for cost tracking) |
| `GEMINI_PRICING_OUTPUT_PER_M` | No | Gemini output pricing (USD per 1M tokens, for cost tracking) |
| `BEDROCK_REGION` | Bedrock only | AWS region for Bedrock runtime (default: `us-east-1`) |
| `BEDROCK_MODEL_ID` | Bedrock only | Bedrock model ID used when provider order includes `bedrock` |
| `BEDROCK_MAX_TOKENS` | Bedrock only | Max output tokens for Bedrock calls (default: `1024`) |
| `BEDROCK_PRICING_INPUT_PER_M` | Bedrock only | Bedrock input pricing (USD per 1M tokens, for cost tracking) |
| `BEDROCK_PRICING_OUTPUT_PER_M` | Bedrock only | Bedrock output pricing (USD per 1M tokens, for cost tracking) |
| `GOOGLE_API_KEY` | No | Weather + venue search |
| `MBTA_API_KEY` | No | Transit data (Boston-specific) |
| `NEWSAPI_KEY` | No | News search |
| `FIRECRAWL_API_KEY` | No | Firecrawl search + page extraction — top-priority web_search provider |
| `BRAVE_SEARCH_API_KEY` | No | Brave Search API — powers the web_search AI tool (default when Firecrawl is not configured) |
| `GOOGLE_SEARCH_ENGINE_ID` | No | Google Programmable Search engine ID for the web_search AI tool |
| `SEARXNG_BASE_URL` | No | Self-hosted SearXNG base URL for the web_search AI tool |
| `WEB_SEARCH_PROVIDER` | No | Optional web_search provider override: `firecrawl`, `brave`, `google`, or `searxng` |
| `SLACK_BOT_TOKEN` | Slack only | Official Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack only | Slack Events API signing secret (Basic Information -> App Credentials) |
| `SLACK_BOT_USER_ID` | Optional | Bot user id for mention matching (`U...`) |
| `SLACK_CLIENT_ID` | Slack rotation | Required for token refresh flow |
| `SLACK_CLIENT_SECRET` | Slack rotation | Required for token refresh flow |
| `SLACK_REFRESH_TOKEN` | Slack rotation | Rotating refresh token from OAuth response |
| `SLACK_TOKEN_STATE_FILE` | Optional | Local persisted token state path (default `data/slack-token-state.json`) |
| `SLACK_TOKEN_ROTATE_MIN_BUFFER` | Optional | Minutes before expiry to refresh (default `5`) |
| `DISCORD_BOT_TOKEN` | Discord only | Official Discord bot token |
| `DISCORD_PUBLIC_KEY` | Discord only | Discord interactions signature public key |
| `OLLAMA_BASE_URL` | No | Local model inference (default: `http://127.0.0.1:11434`) |
| `DB_DIALECT` | No | Database backend: `sqlite` (default) or `postgres` |
| `DATABASE_URL` | Postgres only | Full Postgres connection string (alternative to individual `POSTGRES_*` vars) |
| `POSTGRES_HOST` | Postgres only | Postgres hostname |
| `POSTGRES_PORT` | Postgres only | Postgres port (default: `5432`) |
| `POSTGRES_DB` | Postgres only | Postgres database name |
| `POSTGRES_USER` | Postgres only | Postgres user |
| `POSTGRES_PASSWORD` | Postgres only | Postgres password |
| `POSTGRES_SSL` | Postgres only | Enable SSL for Postgres connection (default: `false`) |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | Postgres only | Reject unauthorized SSL certs (default: `false`) |
| `CONTEXT_SESSION_MEMORY_ENABLED` | No | Enable session memory pipeline (default: `true`) |
| `CONTEXT_SESSION_GAP_MINUTES` | No | Inactivity gap to close a session (default: `30`) |
| `CONTEXT_SESSION_MIN_MESSAGES` | No | Minimum messages to summarize a session (default: `4`) |
| `CONTEXT_SESSION_MAX_RETRIEVED` | No | Max session summaries injected into prompt context (default: `3`) |
| `CONTEXT_SESSION_SUMMARY_VERSION` | No | Summary algorithm version for cache invalidation (default: `1`) |
| `MEMORY_AUTO_EXTRACT` | No | Enable automatic long-term community fact extraction (default: `false`) |
| `MEMORY_AUTO_EXTRACT_MIN_MESSAGES` | No | Per-group messages required between extraction attempts (default: `25`) |
| `MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES` | No | Minimum minutes between extraction attempts per group (default: `360`) |
| `MEMORY_AUTO_MAX_FACTS` | No | Max retained auto-extracted facts (default: `200`) |
| `VECTOR_EMBEDDING_PROVIDER` | No | Embedding provider: `deterministic` (default) or `openai` |
| `VECTOR_EMBEDDING_MODEL` | No | OpenAI embedding model (default: `text-embedding-3-small`) |
| `VECTOR_EMBEDDING_TIMEOUT_MS` | No | Embedding API timeout in ms (default: `12000`) |
| `VECTOR_EMBEDDING_MAX_CHARS` | No | Max input chars for embedding (default: `4000`) |
| `OLLAMA_MODEL` | No | Local Ollama model for simple queries (default: `qwen3:8b`; use a 1-3B model on Pi-class hosts) |
| `HEALTH_PORT` | No | Health endpoint port (default: `3001`) |
| `HEALTH_BIND_HOST` | No | Health bind host (`127.0.0.1` default, use `0.0.0.0` for external monitors) |
| `METRICS_ENABLED` | No | Enable Prometheus `/metrics` scraping on the health server (default: `false`), including expanded community/admin metric families; token auth accepts either `?token=` or `Authorization: Bearer`. |
| `WHATSAPP_LOGIN_MODE` | No | WhatsApp linking UI: `web` (default, browser page), `terminal` (in-terminal QR), or `both` |
| `WHATSAPP_LOGIN_TOKEN` | No | Pin the login/metrics/admin token instead of generating one per run (guards `/whatsapp/login*`, `/metrics`, and `/admin`) |
| `ADMIN_PAGE_ENABLED` | No | Owner admin page at `/admin` + `/admin.json` on the health port (default: `true`; only served when a token exists) |
| `EVENT_REMINDERS_ENABLED` | No | Enable Events-group reminder capture and scheduled reminder sends (default: `true`) |
| `EVENT_REMINDER_LEAD_MINUTES` | No | Minutes before a parsed event start time to post a reminder (default: `120`) |
| `APP_VERSION` | No | Version marker used for Docker image labels + release note headers |
| `OWNER_JID` | Yes | Owner identifier used for admin alerts (WhatsApp JID, Slack user/channel, or Discord user/channel) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

Features degrade gracefully when API keys are missing — the bot won't crash, it just skips that feature.

## Owner admin page

`http://<host>:3001/admin?token=<WHATSAPP_LOGIN_TOKEN>` renders a token-gated,
auto-refreshing snapshot of today's usage: AI spend vs. the $1 alert threshold,
per-provider calls/tokens/cost, per-group activity (messages, active users, bot
replies, moderation flags, AI errors), and the WhatsApp outbound-safety
counters. `/admin.json` returns the same data raw for scripting. The page is
never served without a token, and requests share the health endpoint's rate
limit. Disable with `ADMIN_PAGE_ENABLED=false`.

## Automatic community memory

`MEMORY_AUTO_EXTRACT=false` by default. When enabled, Garbanzo periodically scans
recent group context after a successful group AI response and asks the configured
AI provider to extract 0-3 durable community facts: recurring events, venues,
member roles/projects, traditions, or general long-term facts.

The extractor is gated per group by `MEMORY_AUTO_EXTRACT_MIN_MESSAGES` and
`MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES`, so it adds at most one extra cheap LLM
call per group per interval. Auto-extracted facts are stored with source `auto`,
included in the same prompt memory as owner-added facts, capped by
`MEMORY_AUTO_MAX_FACTS`, and visible in `!memory` with an `(auto)` tag. Curate
them with the existing owner command: `!memory delete <id>`.

## WhatsApp outbound safety (anti-ban)

| Variable | Default | Purpose |
|----------|---------|---------|
| `WHATSAPP_SAFETY_ENABLED` | `true` | Enables the outbound safety layer for WhatsApp sends. |
| `WHATSAPP_SAFETY_MAX_PER_MINUTE` | `5` | Per-minute outbound rate cap. |
| `WHATSAPP_SAFETY_MAX_PER_HOUR` | `100` | Per-hour outbound rate cap. |
| `WHATSAPP_SAFETY_MAX_PER_DAY` | `2000` | Per-day outbound rate cap. |
| `WHATSAPP_SAFETY_MIN_DELAY_MS` | `2500` | Minimum inter-message delay in milliseconds. |
| `WHATSAPP_SAFETY_MAX_DELAY_MS` | `7000` | Maximum inter-message delay in milliseconds. |
| `WHATSAPP_SAFETY_WARMUP_DAYS` | `10` | Number of days a newly linked account follows the warm-up ramp. |
| `WHATSAPP_SAFETY_DAY1_LIMIT` | `2000` | First-day warm-up cap before ramp growth is applied. |
| `WHATSAPP_SAFETY_AUTO_PAUSE_AT` | `medium` | Risk level that automatically pauses outbound WhatsApp sends. |

Two independent gates can stop outbound WhatsApp sends. The warm-up ramp starts
at `WHATSAPP_SAFETY_DAY1_LIMIT` and grows by `day1Limit * growthFactor^day`,
then graduates to unlimited after `WHATSAPP_SAFETY_WARMUP_DAYS`. The rate
limiter separately enforces the per-minute, per-hour, and per-day caps plus the
minimum/maximum inter-message delay. The effective daily cap is the lower of the
warm-up ramp and `WHATSAPP_SAFETY_MAX_PER_DAY`. `WHATSAPP_SAFETY_AUTO_PAUSE_AT`
auto-pauses outbound sends when risk reaches the configured level.

Loosening or disabling for testing: set `WHATSAPP_SAFETY_WARMUP_DAYS=0` to skip
the warm-up ramp, raise the rate caps for a higher test ceiling, or set
`WHATSAPP_SAFETY_ENABLED=false` to turn off rate limits, warm-up, and auto-pause.
Only disable the full safety layer on an established number.

## Event Reminders

Event reminders are captured only from passively detected proposals in the
configured Events group. `EVENT_REMINDERS_ENABLED` controls both capture and the
WhatsApp scheduler. `EVENT_REMINDER_LEAD_MINUTES` sets how early the reminder is
posted before the parsed event start time.

## AI Routing Profiles (Examples)

Cost-optimized routing (fast + affordable cloud-first):

```bash
AI_PROVIDER_ORDER=gemini,openrouter,openai,anthropic
GEMINI_MODEL=gemini-1.5-flash
OPENROUTER_MODEL=anthropic/claude-sonnet-4-5
```

Quality-prioritized routing (high-complexity prompts first):

```bash
AI_PROVIDER_ORDER=anthropic,openai,gemini,openrouter
ANTHROPIC_MODEL=claude-sonnet-5
OPENAI_MODEL=gpt-5.4
```

Hybrid local/cloud routing (keep simple prompts local):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
AI_PROVIDER_ORDER=openrouter,gemini,openai
```

## Native LLM Tool Calling

`AI_TOOL_CALLING=false` by default. When enabled, OpenRouter, Anthropic, and
OpenAI API-key mode can call configured Garbanzo integrations while drafting a
reply. That lets a member ask `@garbanzo is the L running?` and get live transit
data without needing `!transit`.

Available tools mirror existing feature handlers: weather and venue search need
`GOOGLE_API_KEY`, transit needs `MBTA_API_KEY`, news needs `NEWSAPI_KEY`, and
book lookup plus community memory search are available without extra API keys.
`AI_TOOL_MAX_ITERATIONS` limits tool-call rounds per model response from 1 to 5.

## Group Configuration

Edit `config/groups.json` to map your WhatsApp group IDs:

```json
{
  "groups": {
    "YOUR_GROUP_JID@g.us": {
      "name": "General",
      "enabled": true,
      "requireMention": true,
      "persona": "Casual and conversational.",
      "enabledFeatures": ["weather", "transit", "fun"]
    }
  },
  "mentionPatterns": ["@yourbot", "@YourBot"],
  "admins": {
    "owner": {
      "name": "Your Name",
      "jid": "1YOURNUMBER@s.whatsapp.net"
    }
  }
}
```

To find your group JIDs, enable `LOG_LEVEL=debug` and check logs when messages arrive.

**Per-group options:**
- `enabled` — whether the bot responds in this group
- `requireMention` — if true, bot only responds to @mentions (recommended)
- `persona` — custom personality hint for this group (injected into Claude prompt)
- `enabledFeatures` — array of feature names to enable (omit for all features)

> **Docker:** `docker-compose.yml` bind-mounts the host `./config/groups.json`
> read-only into the container, so your edits take effect on `docker compose
> restart` with **no image rebuild**. The file must exist on the host (the setup
> wizard creates it) before `docker compose up`, or Docker will create a directory
> in its place and the bot will fail to start.

## OpenAI OAuth (experimental)

OpenAI supports two auth modes via `OPENAI_AUTH_MODE`:

- **`apikey` (default):** standard `OPENAI_API_KEY` against `api.openai.com`. Recommended.
- **`oauth` (experimental):** use a ChatGPT (Plus/Pro) subscription instead of an API key.

  ```bash
  npm run openai:login   # opens the browser, links your ChatGPT account
  # then set OPENAI_AUTH_MODE=oauth and include "openai" in AI_PROVIDER_ORDER
  ```

  **Headless / remote host (e.g. a Raspberry Pi over SSH).** OpenAI pins the OAuth
  redirect to `http://localhost:1455`, so on a machine with no local browser, run:

  ```bash
  npm run openai:login -- --manual   # or: node scripts/openai-login.mjs --manual
  ```

  It prints the sign-in URL — open it in a browser on any machine, authorize, then
  the browser lands on a dead `localhost:1455/...` page. Copy that URL (or just the
  `code`) back into the terminal prompt. No `ssh -L` tunnel required. (The default
  `npm run openai:login` also falls back to this paste prompt if the callback never
  arrives.) In Docker, the login script isn't in the image — run it on the host to
  write `data/openai-oauth.json`, then load it into the container's volume:
  `docker compose cp data/openai-oauth.json garbanzo:/app/data/openai-oauth.json`
  and `docker compose exec -u root garbanzo chown garbanzo:garbanzo /app/data/openai-oauth.json`.

  > ⚠️ **Unofficial and against OpenAI's Terms of Service.** It reuses the Codex
  > OAuth client to call OpenAI's private ChatGPT backend (SSE streaming) and
  > can break without notice. Verified end-to-end against a live token on
  > 2026-07-02. It is isolated and always falls
  > back to the next provider in `AI_PROVIDER_ORDER` on any failure — never make
  > it your only provider. Tokens are stored in `data/openai-oauth.json`
  > (gitignored, mode `0600`). In oauth mode `OPENAI_MODEL` must be a
  > ChatGPT-backend model slug, not an API model name.
