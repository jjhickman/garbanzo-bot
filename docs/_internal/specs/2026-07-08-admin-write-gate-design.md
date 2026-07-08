# Admin Write-Gate — Design Spec

**Date:** 2026-07-08
**Status:** Design accepted for v3.4.0 implementation (produced in-cycle during v3.3.0 per WS4/Q2 owner directive, so phase 2 starts shovel-ready)
**Scope:** phase-2/3 mutation gate for the `/admin` community operations web UI. Phase 1 (v3.3.0) ships zero mutation endpoints; this doc exists so phase 2 doesn't design its security model under deadline pressure.

## Threat shape

`/admin` today authenticates with `MONITORING_TOKEN` — a single bearer/query token that also authenticates `/metrics` scrapes and falls back to the Grafana admin password. It was designed as a **read** credential: leaking it exposes usage stats and cost data, not state. Phase 2 turns the same page into a write surface (memory delete/share, persona/charter edit, config import, eventually bridge-map edits) without changing that token model, the read credential would silently become a write credential.

The realistic deployment shape makes this concrete, not theoretical: `docker-compose.yml` publishes the WhatsApp service on `0.0.0.0:3001:3001` (the Discord service instead binds `127.0.0.1:3002:3002` — WhatsApp is deliberately LAN-reachable so the login QR page works from a phone). `MONITORING_TOKEN` also rides Prometheus scrape configs and Grafana's stored datasource credential, both plaintext-at-rest by design for a Pi-class self-hosted stack. Anyone who can read the Prometheus config, a Grafana screenshot, or LAN traffic (the admin page is plain HTTP, no TLS, by design for a home LAN) gets the same token that would gate mutation. **Reference threat: an unauthenticated LAN peer, or anyone who has ever seen the monitoring token, reaching the published WhatsApp health port.**

## Why a loopback-source check fails under Docker

The obvious "cheap" fix — accept mutations only from `127.0.0.1` — was raised and rejected in the v3.2 review cycle for a specific, verifiable reason: Docker's networking model breaks the assumption that "source is loopback" means "source is trusted."

- With the default bridge network and the userland/iptables port-publishing Docker uses for `0.0.0.0:PORT:PORT` mappings, host-originated connections to a published port do **not** arrive at the container as `127.0.0.1`. They arrive with a source address on the Docker bridge subnet (the gateway address, typically `172.17.0.1` or similar) — because the connection is NATed through `docker-proxy`/iptables before it reaches the container's network namespace.
- That same bridge-subnet source address is indistinguishable, from inside the container, from a **LAN peer** whose traffic was routed through a reverse-proxy or sidecar container also attached to the bridge network. A container has no reliable way to tell "this is the Docker host operator" from "this is another container, or a LAN box that reached the host's published port" — the NAT hop erases the distinction.
- Compose profiles and Docker Desktop (macOS/Windows) add further translation layers (a VM boundary) that make the gateway address even less predictable across host OSes.

A loopback check would therefore either (a) reject legitimate host-originated admin requests once compose is in play, forcing operators to disable it (defeating the point), or (b) get "fixed" by widening the accepted range to the whole bridge subnet, which is exactly the LAN-reachable surface the design is supposed to close. This is why source-IP trust is evaluated below as a *documented, opt-in* mechanism, never a default.

## Candidates evaluated

### 1. Separate admin listener on an operator-chosen bind

A second HTTP listener, distinct from the existing `HEALTH_PORT`/`HEALTH_BIND_HOST` server, serves only the phase-2+ mutation routes (`/admin/api/*`). It defaults to `127.0.0.1` regardless of what the read-only health/admin port is bound to — so the WhatsApp instance's LAN-published health port stays read-only, and mutation stays host-only unless the operator explicitly republishes the new port.

- **Cost:** one more compose port block + one more env var (`ADMIN_WRITE_BIND_HOST`, `ADMIN_WRITE_PORT`) to document; a second `createServer()` instance in the process (trivial overhead — the process already runs a Baileys/discord.js socket plus the existing health server). Remote access requires an explicit choice: SSH tunnel, Tailscale, or a reverse proxy with TLS — the same pattern MONITORING.md already recommends for Grafana on an untrusted LAN.
- **Benefit:** closed by default even on the one platform (WhatsApp) whose read port is deliberately LAN-open. Doesn't depend on any traffic-inspection heuristic, so it isn't defeated by the Docker NAT problem above. Mirrors an existing precedent — `WHATSAPP_LOGIN_TOKEN` already gates a separate sensitive surface (the login QR page) independently of `MONITORING_TOKEN`, so "a second dedicated gate for a second sensitive surface" isn't a new pattern for this codebase.

### 2. A distinct `ADMIN_WRITE_TOKEN` tier above `MONITORING_TOKEN`

Keep one listener; require a second, higher-privilege bearer token on mutation routes, checked with the same `timingSafeEqual` helper `requestHasValidToken` already uses.

- **Cost:** near zero — no new port, no new server, one new required env var, one new comparison in the route handler.
- **Benefit:** trivial to implement and test; strictly better than today (a leaked `MONITORING_TOKEN` — the one shared with Prometheus/Grafana — no longer implies write access).
- **Gap:** it does not change *where* the request can come from. On the WhatsApp instance the mutation route is exposed on the same LAN-published `0.0.0.0` port as the read-only page. Anyone who obtains the write token (packet capture on unencrypted LAN HTTP, a copy-pasted `.env`, a shoulder-surfed terminal) can mutate from anywhere on the LAN. A second token raises the bar; it doesn't close the exposure the grounding section calls out.

### 3. Trusted-source handling with documented compose behavior

Accept mutations only from an operator-configured allowlist of source CIDRs (default: loopback + the container's own Docker bridge subnet, override via `ADMIN_TRUSTED_CIDRS`), documented per compose topology.

- **Cost:** highest of the three — requires operators to know and correctly declare their own Docker network mode (default bridge vs `network_mode: host` vs a custom bridge subnet vs Docker Desktop's VM layer), and the guidance has to be re-verified per Docker version/host OS.
- **Gap:** this is precisely the mechanism the grounding section shows is unreliable under the default bridge network — a LAN peer routed through a reverse-proxy container on the same bridge can present the same source address as the host. A misconfigured allowlist is a *silent* false-permissive failure: the page looks gated (still asks for a token) but the source check that was supposed to be the second layer quietly admits more than intended. That failure mode — looks secure, isn't — is worse than an admin route that's honestly unavailable until deliberately opened.

## Recommendation

**Ship candidate 1 (separate admin listener, host-only default bind) as the primary mechanism, with candidate 2 (a distinct `ADMIN_WRITE_TOKEN`) layered on top of that listener as defense in depth.** Reject candidate 3 as a default — it can be offered later as an opt-in, explicitly-documented *additional* layer for operators who understand their own compose topology, never as the sole gate.

Rationale: candidate 1 is the only option that actually changes the exposure described in the grounding section (a LAN-published WhatsApp health port) rather than just raising the value of what an attacker on that LAN needs to steal. Candidate 2 alone is cheap but insufficient on its own; paired with candidate 1 it costs nothing extra to add (same token-check code the read path already has) and means a leaked `ADMIN_WRITE_TOKEN` still doesn't help an attacker who can't reach the host-only port.

**Costed UX for operators:**
- Do nothing beyond upgrading to v3.4.0 → the admin-write listener starts bound to `127.0.0.1` inside the container. Operators who already use `docker exec`, SSH tunnels, or a Tailscale-connected laptop for admin work get mutation for free with zero new config, and the WhatsApp instance's LAN-open health port stays read-only exactly as before.
- Want the phase-2 web UI reachable from a phone on the LAN → set `ADMIN_WRITE_BIND_HOST` and publish the new port in compose, generate `ADMIN_WRITE_TOKEN` (identical `openssl rand -hex 32`-style guidance already used for `MONITORING_TOKEN`/`WHATSAPP_LOGIN_TOKEN`), and are pointed at the reverse-proxy-with-TLS pattern MONITORING.md already documents for Grafana. This is one new doc section, not a new concept.
- Cost is proportional to intent: read-only stays zero-config; mutation stays zero-config for host-adjacent access; LAN/remote mutation access is an explicit, documented, one-time opt-in — matching the phase-1 principle that the risky half of this feature never ships implicitly.

## Audit-log shape

Every mutation writes one row to a new append-only `admin_audit_log` SQLite table (mirrors the existing pattern of dedicated tables per concern — `bridge_outbox`, `whatsapp_outbound_jobs` — rather than reusing an unrelated table):

- **what:** an action tag (`memory.delete`, `memory.share`, `memory.unshare`, `charter.edit`, `config.import`, `bridge_map.edit`, …) plus a target identifier (fact id, file path, route id) and a bounded change summary — full before/after for small mutations (a memory fact, a toggle), a size/checksum only for large blobs (a config export/import archive), never the raw archive contents in the log row.
- **when:** unix-ms timestamp.
- **from-where:** source IP as observed by the write listener (still logged as *context*, not as an auth boundary — the same Docker source-address caveat from the grounding section applies, so it's captured for incident review, not trusted for access control) plus whether the request presented a valid `ADMIN_WRITE_TOKEN` (never the token value itself).
- **storage:** the same per-instance SQLite database mutations already live in — no new infra. Retention follows the existing `runMaintenance`/backup rotation pattern (bounded window, e.g. 90 days) so an audit table doesn't grow unbounded on a Pi's SD card the way an unpruned message table would. The audit log itself is read-only from the web UI (a phase-1-style read view once phase 2 exists) — there is no "delete audit entry" endpoint, on purpose.

## Confirm-step UX

Phase 1's "no SPA, no build step" constraint carries into phase 2: no client-side JS confirm dialog. Destructive mutations (memory delete, config import that overwrites GARBANZO_HOME config, a bridge-map edit that removes a route) use a two-request, server-rendered confirm flow:

1. The mutating form submits to a `*/confirm` route that does **not** mutate. It renders a page restating exactly what will change (before/after, called out irreversibility) and a single button POSTing to the real mutation endpoint, carrying a short-lived server-side nonce (stored in-process, few-minute TTL, single-use) instead of relying on a JS-built confirmation dialog.
2. The real mutation endpoint rejects any POST without a valid, unexpired, unused nonce — closing the CSRF gap a bare "click this link to delete" pattern would otherwise open.

Non-destructive mutations (share/unshare a fact, a reversible toggle) skip the confirm step; the audit log is still the record of what happened.

## Schema-validation reuse

Config-shaped mutations (charter/persona file writes, `config/groups.json` toggles, config import, eventually the bridge-map editor) validate through the **exact same zod schemas boot already uses** — never a parallel "web UI" validator:

- Env-shaped config goes through the same schema `src/utils/config/index.ts` parses at boot.
- JSON configs reuse their existing schemas directly — `BridgeMapSchema` (already used by `loadBridgeMap()` and already produces operator-facing, entry-naming error messages via `formatBridgeMapZodError`) is the phase-3 bridge-map editor's validator with no new schema to write or drift from. `config/groups.json` reuses `GroupsConfigSchema` the same way.
- A failed validation blocks the write entirely — the same "reject with a clear per-entry error, write nothing" behavior the boot-time loaders already have, extended to the web UI instead of reimplemented for it.
- Config import specifically reuses the wizard's existing preserve/merge/backup semantics (diff preview + automatic `.bak` before any write), so import doesn't introduce a second "how do we not clobber operator config" story alongside the one `npm run setup` already solved.

## Phase-2 / phase-3 endpoint inventory this gates

All routes below sit behind the write listener + `ADMIN_WRITE_TOKEN` (never the plain read `MONITORING_TOKEN` alone); destructive ones additionally require the confirm-nonce flow.

**Phase 2 (v3.4.0):**
- `DELETE /admin/api/memory/:id` — destructive, confirm required. Parity with `!memory delete`.
- `POST /admin/api/memory/:id/share`, `POST /admin/api/memory/:id/unshare` — reversible, no confirm step. Parity with `!memory share`/`!memory unshare`; gated on `SHARED_MEMORY_ENABLED` same as the command.
- `GET /admin/api/charter`, `PUT /admin/api/charter` — persona/charter file view + edit at the platform-keyed home slot (`GARBANZO_HOME/docs/personas/<platform>.md`, `.bak` on overwrite — the same slot and precedence WS10's wizard picker writes to).
- `GET /admin/api/groups`, `PUT /admin/api/groups/:jid` — group/channel toggle view + edit, validated against `GroupsConfigSchema`.
- `GET /admin/api/config/export` — download a GARBANZO_HOME config archive (non-destructive, no confirm needed, but still audit-logged since it's a data-exposure action worth a trail).
- `POST /admin/api/config/import` — destructive, confirm required, diff preview before the confirm step, `.bak` before write, validated per-file against the matching zod schema.

**Phase 3 (v3.5.0):**
- `GET /admin/api/bridge-map`, `PUT /admin/api/bridge-map` — bridge-map editor, destructive, confirm required, validated against `BridgeMapSchema` (reusing `formatBridgeMapZodError` for operator-facing error text).
- Demand-proven follow-ons — no endpoint ships here without a concrete request; this list is deliberately not pre-expanded.

## Non-goals (this design)

Web UI user accounts (token gating stays the model — this design adds a tier, not a login system); TLS termination inside the bot process (documented as the operator's reverse-proxy responsibility, same as Grafana's untrusted-LAN guidance); a generic source-IP trust framework (candidate 3 stays opt-in/documented, never default); changing `MONITORING_TOKEN`'s existing read-path behavior.
