# Prompt behavior evals

`prompt-eval-set.json` is a regression suite for the bot's *behavior*, not its code: 40+ realistic inbound community messages, each with the expected response behavior. Use it whenever you change `docs/PERSONA.md`, `src/ai/persona.ts`, `src/ai/tools.ts`, or the model/provider configuration — those changes pass the unit tests while silently changing what the bot actually says.

## Case format

```json
{
  "id": "tool-weather-01",
  "category": "tool_routing | refusal | injection | persona_voice | identity | moderation | edge_case",
  "group": "which community group the message arrives in",
  "message": "the inbound text, as a member would type it",
  "quoted": "(optional) replied-to message content",
  "notes": "(optional) harness conditions, e.g. 'web_search returns an error'",
  "expected": {
    "tool": "tool name the model should call, or null for 'no tool' — omit when not the point",
    "behavior": "one-sentence description of the right response",
    "must": ["strings/properties the response should contain"],
    "mustNot": ["failure modes this case exists to catch"]
  }
}
```

`tests/prompt-eval-set.test.ts` validates the file's schema in CI (unique ids, valid tool names, category coverage). It does **not** run the model.

## How to run against the model

Until an automated runner exists, the cheap manual loop after a prompt change:

1. Pick the categories your change touches (e.g. a `tools.ts` edit → `tool_routing` cases; a PERSONA.md edit → `refusal`, `injection`, `persona_voice`).
2. Send each case's `message` through a dev instance (or replay via the demo servers) with the case's `group` context.
3. Check the response against `expected.behavior`, `must`, and `mustNot`. A `tool` expectation is checked against the tool-call log (`recordToolCall` counters in stats).
4. Any regression: fix the prompt, re-run just that category.

Cases with `notes` describing harness conditions (simulated tool failures, injected page content) need those conditions arranged manually or mocked.

## Automated runner (future work, sized for an agent)

Build `scripts/run-prompt-evals.mjs`: for each case, call `buildSystemPrompt()` with the case's group context, send `message` through the existing provider stack (`src/ai/router.ts`) with tools enabled but `execute` stubbed to canned fixtures, then grade with a cheap LLM judge against `expected`. Report pass/fail per category. Acceptance: runs against any configured provider, costs pennies per full run, exits non-zero on regressions vs a recorded baseline.

## Maintaining the set

- Add a case whenever production misbehaves — the message that exposed the problem *is* the eval.
- Keep messages realistic (typos, lowercase, slang) — sanitized test-speak defeats the purpose.
- Real member names in production incidents get replaced with placeholder names before adding a case here (PII guard applies to this file too).
