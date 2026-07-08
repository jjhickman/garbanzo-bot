# Customizing for Your Community

Garbanzo was built for Boston communities, but the runtime is configurable by persona files, platform config files, and feature env vars.

## Persona

`docs/PERSONA.md` is the base prompt. `src/ai/persona.ts` derives the display name with `getPersonaName()` from that document, so changing the main heading changes the bot identity used in logs and help text.

Platform overrides live in `docs/personas/<platform>.md`, such as `docs/personas/discord.md`. Docker operators can bind-mount replacement persona files into those paths instead of rebuilding the image.

### Persona Gallery

`docs/personas/gallery/` ships six ready-to-use personas, each demonstrating a real feature set:

- **Riff 🎸** — bands and music projects (songs, rehearsals, setlists, idea capture; needs `BAND_FEATURES_ENABLED`).
- **Quill 🎲** — tabletop groups (memory-as-canon, session recaps, scheduling, the character sheet generator).
- **Margie 📚** — book clubs (book lookups, reading schedule, spoiler-aware moderation).
- **Bea 🏡** — neighborhood and mutual-aid groups (welcomes, events, weather, practical community memory).
- **Patch 🔧** — open-source and maker communities (contributor welcomes, decision memory, weekly recaps, CoC moderation).
- **Callie 🎭** — theater, dance, and rehearsal-based groups (rehearsal calls, availability, run order; needs `BAND_FEATURES_ENABLED`).

`npm run setup` offers the gallery interactively (alongside the default persona and a custom file path) right after the platform is chosen. Non-interactively, pass `--persona=<name>` (case-insensitive, e.g. `--persona=quill`) or a file path. Either way the selection is written to the platform-keyed slot, `GARBANZO_HOME/docs/personas/<platform>.md` — an existing file there is backed up to `.bak` first. This is independent of the older `--persona-file`, which replaces `docs/PERSONA.md` at the home root. Picking Riff or Callie offers (interactively) or notes (non-interactively) turning on `BAND_FEATURES_ENABLED`.

Every gallery file is a starting point — copy it, edit the personality, and make it yours.

## Discord Channels

Copy `config/discord-channels.example.json` to `config/discord-channels.json` and fill in real Discord channel, role, and owner ids. Override the path with `DISCORD_CHANNELS_CONFIG_PATH` when needed.

## WhatsApp Groups

Edit `config/groups.json` for WhatsApp group names, enabled features, mention patterns, owner metadata, and per-group persona hints.

## Locale and Integrations

- Transit uses the MBTA API through `MBTA_API_KEY` and Boston-specific aliases in `src/features/transit-data.ts`.
- Weather defaults live in the weather feature and can be adapted for another default city.
- Venue, news, books, and web-search behavior depends on the optional API keys listed in `.env.example`.

## Memory

This is your community's lore: the facts your bot remembers about the group. Teach local community facts with `!memory add`. Share facts across instances only with explicit owner commands such as `!memory share <id>`.
