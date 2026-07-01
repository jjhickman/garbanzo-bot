# Customizing for Your Community

Garbanzo was built for Boston, but the architecture is locale-agnostic. Here's what to customize:

## 1. Persona (`docs/PERSONA.md`)
This file defines the bot's personality and is loaded at runtime into every AI prompt. Replace Boston references with your city, update the voice/tone, and adjust the "community knowledge" section.

## 2. Transit (`src/features/transit.ts`)
Currently uses the MBTA API. To adapt:
- Replace the API client with your city's transit API
- Update station/route aliases in the lookup maps
- Adjust the response formatting

## 3. Weather (`src/features/weather.ts`)
Default location is Boston. Change the `DEFAULT_LOCATION` constant to your city.

## 4. Groups (`config/groups.json`)
Replace all group JIDs and names with your own. Persona hints are per-group.

## 5. Mention Patterns (`config/groups.json`)
Update `mentionPatterns` to match your bot's name as it appears in WhatsApp.

## 6. Icebreakers (`src/features/fun.ts`)
The curated icebreaker list is Boston-themed. Replace with your city's landmarks, neighborhoods, and culture.

## 7. Memory Facts (`!memory add`)
After deploying, use `!memory add` to teach the bot about your community's venues, traditions, and members.
