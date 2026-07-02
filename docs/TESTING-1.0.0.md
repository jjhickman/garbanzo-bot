# v1.0.0 WhatsApp Acceptance Test Plan
> Everything shipped between v0.2.4 and v1.0.0 (#190–#202), in dependency order.
> Assumes the Pi runs 1.0.0 with `AI_TOOL_CALLING=true` and `MEMORY_AUTO_EXTRACT=true`.

**Legend:** 👤 = from your personal WhatsApp (owner) · 👥 = ask a friend / second account · 💻 = terminal on the Pi

---

## 0. Preflight (💻, 2 min)

```bash
curl -s http://127.0.0.1:3001/health | jq '.status, .backup'
docker logs garbanzo 2>&1 | grep -E "Connected to WhatsApp|version" | tail -5
docker logs garbanzo 2>&1 | grep -iE "error|fail" | tail -10   # should be quiet
```

- [ ] `status: "connected"` — Baileys **v7** relinked using the existing auth (no QR needed)
- [ ] No error spam in logs

## 1. v0.2.4 regression sweep (👤 in an enabled group, 10 min)

- [ ] `@garbanzo hello` → replies in persona
- [ ] `!help` → command list renders
- [ ] `!weather` · `!transit` · `!news` · `!book dune` · `!roll 2d6+3` · `!trivia`
- [ ] `!poll Lunch spot? / Tacos / Pho / Pizza` → native poll appears
- [ ] Send a **photo** + `@garbanzo what is this?` → vision reply
- [ ] Send a **voice note** (if Whisper is up) → transcribed + answered
- [ ] Reply "thanks!" to a bot message → 🫘 reaction
- [ ] 👥 Intro post in **Introductions** (no mention) → personal welcome

## 2. Owner commands — the LID fix (#190) (👤 DM to the bot)

This entire section silently failed on 0.2.4 whenever WhatsApp used your LID.

- [ ] `!help` → owner section included
- [ ] `!memory` → fact list · `!digest` → today's preview · `!strikes` · `!whatsapp status`
- [ ] Rate-limit exemption: send 12 mentions inside 5 min in a group — all answered (non-owners cap at 10)

## 3. Native tool calling (#198) — no bang commands (👤 or 👥 in a group)

Natural questions; the model should pull **live data** mid-reply:

- [ ] `@garbanzo is the red line running okay right now?` → real MBTA status
- [ ] `@garbanzo what's the weather looking like tomorrow evening?` → forecast numbers
- [ ] `@garbanzo any good taco spots near Somerville?` → actual venues
- [ ] `@garbanzo do you remember anything about book club?` → pulls from `!memory` facts
- [ ] 💻 `docker logs garbanzo | grep -i tool` → tool invocations visible
- [ ] Failure containment: ask about a feature whose API key is unset → graceful reply, no crash

## 4. Automatic memory (#195) (👤)

Defaults are deliberately slow (25 fresh msgs + 6h/group). For a fast test, temporarily set in `.env`:
`MEMORY_AUTO_EXTRACT_MIN_MESSAGES=5` and `MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES=10`, then `docker compose up -d`.

- [ ] Chat ~6 messages containing a durable fact ("board game night is first Tuesdays at Aeronaut"), end with a mention so the bot replies
- [ ] Within a minute: 👤 DM `!memory` → the fact appears tagged **(auto)**
- [ ] `!memory delete <id>` works on it
- [ ] Small talk alone ("lol", "nice") does **not** create facts
- [ ] Restore the two env values afterwards

## 5. Edit awareness (#199) (👥 best, in a group)

- [ ] Post a clean message → **edit it** into something that trips a moderation pattern → 👤 owner DM gets the alert (on 0.2.4 edits were invisible)
- [ ] In Introductions: post small talk, then edit it into a real intro → welcome arrives once
- [ ] Edit a message that mentioned the bot → **no second reply**

## 6. Event reminders (#201) (👤 in the Events group)

- [ ] Post `Trivia night this Saturday 7pm at Parlor` → enrichment reply (weather/transit)
- [ ] 👤 DM `!events` → reminder listed with id + parsed time
- [ ] `!events cancel <id>` → confirmed
- [ ] Live fire (optional): post an event ~3h out; ⏰ reminder posts ~2h before (`EVENT_REMINDER_LEAD_MINUTES`)
- [ ] Vague dates ("sometime next month") do **not** create reminders

## 7. Weekly recap (#200) (👤 DM)

- [ ] `!recap` → 7-day totals, per-group leaderboard, unique-participant count
- [ ] Scheduled: Sunday 18:00 DM arrives (check next Sunday)

## 8. Admin page (#196) (any browser on your LAN)

- [ ] `http://pi5.local:3001/admin?token=<WHATSAPP_LOGIN_TOKEN>` → spend bar, provider mix, per-group table, safety counters
- [ ] Auto-refreshes every 30s; `/admin.json` returns raw JSON
- [ ] Without/with wrong token → 401 · `curl http://pi5.local:3001/admin` from another device → 401

## 9. Backups (#191) (💻)

```bash
systemctl list-timers garbanzo-backup.timer          # next run scheduled
sudo systemctl start garbanzo-backup.service
journalctl -u garbanzo-backup.service -n 20          # "Archive OK"
ls -lh /media/josh/T9/garbanzo-backups/              # archive + .sha256
bash scripts/host/garbanzo-restore.sh --list
```

- [ ] Archive exists on the T9 with checksum; fstab `nofail` line present (`grep T9 /etc/fstab`)

## 10. Baileys v7 resilience (#202) (💻 + 👥)

- [ ] `docker restart garbanzo` → reconnects **without QR** within ~30s; bot answers afterwards
- [ ] 👥 have someone join a group → welcome message (v7 changed participant objects)
- [ ] A LID-delivered sender (most iPhone users) gets normal replies + profile continuity

## 11. OpenAI OAuth smoke — optional, ToS-grey (#194) (💻)

- [ ] Set `OPENAI_AUTH_MODE=oauth`, `AI_PROVIDER_ORDER=openai,anthropic`, restart → mention the bot → reply arrives; logs show `chatgpt.com` call → **revert both values**

## 12. Wrap-up checks

- [ ] 21:00 daily digest DM arrives; costs match the admin page
- [ ] `!whatsapp status` counters sane after all of the above
- [ ] `curl -s "http://127.0.0.1:3001/metrics?token=<token>" | head` works

---
*File issues for anything that fails — reference the PR number in the section header.*
