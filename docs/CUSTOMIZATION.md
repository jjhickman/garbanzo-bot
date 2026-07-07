# Customizing for Your Community

Garbanzo was built for Boston communities, but the runtime is configurable by persona files, platform config files, and feature env vars.

## Persona

`docs/PERSONA.md` is the base prompt. `src/ai/persona.ts` derives the display name with `getPersonaName()` from that document, so changing the main heading changes the bot identity used in logs and help text.

Platform overrides live in `docs/personas/<platform>.md`, such as `docs/personas/discord.md`. Docker operators can bind-mount replacement persona files into those paths instead of rebuilding the image.

## Discord Channels

Copy `config/discord-channels.example.json` to `config/discord-channels.json` and fill in real Discord channel, role, and owner ids. Override the path with `DISCORD_CHANNELS_CONFIG_PATH` when needed.

## WhatsApp Groups

Edit `config/groups.json` for WhatsApp group names, enabled features, mention patterns, owner metadata, and per-group persona hints.

## Locale and Integrations

- Transit uses the MBTA API through `MBTA_API_KEY` and Boston-specific aliases in `src/features/transit-data.ts`.
- Weather defaults live in the weather feature and can be adapted for another default city.
- Venue, news, books, and web-search behavior depends on the optional API keys listed in `.env.example`.

## Memory

Teach local community facts with `!memory add`. Share facts across instances only with explicit owner commands such as `!memory share <id>`.
