# Contributing to Garbanzo

Thanks for your interest in contributing! Garbanzo is a community WhatsApp bot built for a Boston-area meetup group, but the codebase is designed to be adaptable for any community.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/garbanzo-bot.git`
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and add your API keys
5. Run the test suite: `npm test`

## Development Workflow

```bash
npm run dev        # Hot-reload development (requires WhatsApp auth)
npm run typecheck  # Type-check only
npm run test       # Run all tests
npm run check      # Full pre-commit check (typecheck + lint + test)
npm run gh:status  # Show authenticated GitHub accounts
npm run gh:ensure  # Verify owner + author accounts exist locally
```

**Always run `npm run check` before submitting a PR.**

## Code Style

- **TypeScript strict mode** — no `any`, no implicit returns
- **ES Modules** — `import`/`export`, never `require()`
- **Zod** for runtime validation of external inputs
- **Pino** for logging — never `console.log`
- **Functional composition** — prefer pure functions over classes
- **Naming:** `camelCase` functions/vars, `PascalCase` types, `SCREAMING_SNAKE` constants
- **Files:** `kebab-case.ts`, one concern per file, max ~300 lines

## Adding a Feature

Each feature lives in its own file under `src/features/`:

1. Create `src/features/your-feature.ts`
2. Add bang command(s) to `BANG_COMMANDS` in `src/features/router.ts`
3. Add natural language patterns to `FEATURE_PATTERNS` if appropriate
4. Wire into `src/bot/handlers.ts`
5. Write tests in `tests/`
6. Update `src/features/help.ts` with the new command(s)

## Commit Messages

Follow the format: `type: short description`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Examples:
- `feat: add weather command`
- `fix: handle empty message body`
- `docs: update ROADMAP with Phase 3 status`

## GitHub PR Account Workflow

Use separate accounts to keep review discipline consistent:

- `garbanzo-dev`: opens and updates PRs (author role)
- `jjhickman`: reviews/approves/merges (owner role)

Switch accounts with helper scripts:

```bash
npm run gh:switch:author
npm run gh:switch:owner
npm run gh:whoami
```

## Credential Rotation (GitHub Secrets)

Monthly rotation reminders are automated via `.github/workflows/credential-rotation-reminder.yml`.

To push newly rotated provider keys into GitHub Actions secrets from local env vars:

```bash
OPENAI_API_KEY=... OPENROUTER_API_KEY=... ANTHROPIC_API_KEY=... npm run rotate:gh-secrets
```

## What to Contribute

- Bug fixes (check Issues)
- New feature commands (propose in an Issue first)
- Test coverage improvements
- Documentation improvements
- Locale adaptations (see README for customization guide)

## What NOT to Contribute

- Changes to `config/groups.json` group IDs (those are instance-specific)
- API keys or secrets in any file
- Autonomous agent behaviors (scheduled messages, proactive outreach) without discussion
- Dependencies without discussion in an Issue first

## Testing

All tests use Vitest with mocked external services (no real API calls):

```bash
npm test                              # All tests
npx vitest run tests/features.test.ts # Specific file
npm run test:watch                    # Watch mode
```

## Questions?

Open an Issue or reach out to the maintainer.
