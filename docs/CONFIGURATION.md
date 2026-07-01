# Configuration

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MESSAGING_PLATFORM` | No | Messaging runtime target (`whatsapp`, `slack`, `discord`, `teams`) |
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` or `OPENAI_API_KEY` or `GEMINI_API_KEY` or `BEDROCK_MODEL_ID` | Yes | Cloud AI responses (Claude/OpenAI/Gemini/Bedrock failover) |
| `AI_PROVIDER_ORDER` | No | Comma-separated cloud provider priority (e.g., `bedrock,gemini,openai,openrouter,anthropic`) |
| `ANTHROPIC_MODEL` | No | Anthropic model override (default: `claude-sonnet-4-5-20250514`) |
| `OPENROUTER_MODEL` | No | OpenRouter model override (default: `anthropic/claude-sonnet-4-5`) |
| `OPENAI_MODEL` | No | OpenAI model override (default: `gpt-4.1`; oauth mode uses a ChatGPT-backend slug) |
| `OPENAI_AUTH_MODE` | No | `apikey` (default) or `oauth` ("Sign in with ChatGPT", experimental — see below) |
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
| `BRAVE_SEARCH_API_KEY` | No | Brave Search API (venue/web search fallback) |
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
| `VECTOR_EMBEDDING_PROVIDER` | No | Embedding provider: `deterministic` (default) or `openai` |
| `VECTOR_EMBEDDING_MODEL` | No | OpenAI embedding model (default: `text-embedding-3-small`) |
| `VECTOR_EMBEDDING_TIMEOUT_MS` | No | Embedding API timeout in ms (default: `12000`) |
| `VECTOR_EMBEDDING_MAX_CHARS` | No | Max input chars for embedding (default: `4000`) |
| `HEALTH_PORT` | No | Health endpoint port (default: `3001`) |
| `HEALTH_BIND_HOST` | No | Health bind host (`127.0.0.1` default, use `0.0.0.0` for external monitors) |
| `WHATSAPP_LOGIN_MODE` | No | WhatsApp linking UI: `web` (default, browser page), `terminal` (in-terminal QR), or `both` |
| `WHATSAPP_LOGIN_TOKEN` | No | Pin the login/metrics token instead of generating one per run (guards `/whatsapp/login*` and `/metrics`) |
| `APP_VERSION` | No | Version marker used for Docker image labels + release note headers |
| `OWNER_JID` | Yes | Owner identifier used for admin alerts (WhatsApp JID, Slack user/channel, or Discord user/channel) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

Features degrade gracefully when API keys are missing — the bot won't crash, it just skips that feature.

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
ANTHROPIC_MODEL=claude-sonnet-4-5-20250514
OPENAI_MODEL=gpt-4.1
```

Hybrid local/cloud routing (keep simple prompts local):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
AI_PROVIDER_ORDER=openrouter,gemini,openai
```

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
  > OAuth client to call OpenAI's private ChatGPT backend, can break without
  > notice, and is **not validated end-to-end**. It is isolated and always falls
  > back to the next provider in `AI_PROVIDER_ORDER` on any failure — never make
  > it your only provider. Tokens are stored in `data/openai-oauth.json`
  > (gitignored, mode `0600`). In oauth mode `OPENAI_MODEL` must be a
  > ChatGPT-backend model slug, not an API model name.
