# Quickstart (No Docker)
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

A single-instance install that runs as a plain Node.js process instead of
through Docker Compose. Good for a semi-technical operator who wants a
working bot fast and doesn't need the full monitoring/bridging stack. Docker
Compose is still the recommended path for multi-instance or production
deployments; see the main [README](../README.md) and
[docs/INFRASTRUCTURE.md](INFRASTRUCTURE.md) for that door.

## Prerequisites

- Node.js 20 or newer (check with `node --version`).
- An always-on machine to run the process on, or a way to keep it running
  across reboots (see "Running as a service" below).
- Linux and macOS are supported tiers. Windows works but is experimental
  this release: the CI smoke matrix for Windows is non-blocking, and there's
  no automated service install yet (see below).

## Get the code

```bash
git clone https://github.com/jjhickman/garbanzo-bot.git
cd garbanzo-bot
npm ci
```

> Coming soon: once `garbanzo-bot` is published to npm, this step becomes
> `npx garbanzo-bot setup` with no git clone required. Until then, the
> git-clone path above is the supported quickstart.

## Run the setup wizard

```bash
npm run setup
```

The wizard asks for, in order:

- AI provider keys and the failover order (`AI_PROVIDER_ORDER`).
- Your messaging platform. Discord is the quickstart default; WhatsApp is
  also available and carries the same account-risk caveat as the Docker path
  (see "WhatsApp on this path" below).
- Deployment target: choose "Native Node.js process" (or pass
  `--deploy=native` non-interactively).
- For Discord, a developer-portal walkthrough in portal order: application
  (client) ID, bot token, an invite URL the wizard builds for you, your
  owner user ID, and at least one channel to enable. It writes
  `config/discord-channels.json` with that channel already enabled, so the
  bot responds to a mention right away. The wizard won't finish with zero
  enabled channels. See [docs/PLATFORMS.md](PLATFORMS.md) for what each
  portal step looks like.
- Vector memory defaults to `VECTOR_STORE=none` (keyword-only) on this path;
  the wizard prints a one-line reminder of how to switch to Qdrant later.
  Monitoring prompts are skipped entirely, since there's no Compose stack to
  enable them on.

Non-interactive setup (for scripting, CI, or re-running with saved values)
uses the same flags as the Docker path plus `--deploy=native`; see
[docs/SETUP_EXAMPLES.md](SETUP_EXAMPLES.md) for a worked native example.

## Where things live (`GARBANZO_HOME`)

Config, the SQLite database, and WhatsApp auth state all resolve against a
`GARBANZO_HOME` directory, in this order:

1. The `GARBANZO_HOME` environment variable, if set, always wins.
2. Once installed from a published npm package, the home directory defaults
   to `~/.garbanzo`, created on first run.
3. Otherwise, which includes this quickstart's git-clone path, the home
   directory is the repository checkout itself: `data/`, `config/*.json`,
   `.env`, `.env.<platform>`, and `baileys_auth/` all live at the repo root,
   same as always.

You generally don't need to set `GARBANZO_HOME` by hand; it's documented
here so you know where to look when backing up or debugging.

## Start the bot

```bash
npm run build
npm start
```

For iterative development instead of a production run, use `npm run dev`
(hot reload); see [docs/PLATFORMS.md](PLATFORMS.md).

## Running as a service

`node dist/cli.js service install` writes a systemd user unit on Linux or a
launchd agent on macOS so the bot survives reboots (`garbanzo service
install` once the package is published):

```bash
node dist/cli.js service install
```

It prints the exact commands to enable the generated unit, for example on
Linux:

```bash
systemctl --user daemon-reload
systemctl --user enable --now garbanzo.service
journalctl --user -u garbanzo.service -f
```

Pass `--system` to install a system-wide systemd unit under `sudo` instead
of a per-user one. On macOS, load the generated agent with `launchctl load`.

The generated unit pins the Node binary path in use at install time. If you
manage Node with a version manager (nvm, asdf, and similar) and switch
versions later, re-run `node dist/cli.js service install` (or `garbanzo
service install`) so the unit points at the new path.

Windows doesn't have automated service installation this release; the CLI
prints Task Scheduler guidance instead. `node dist/cli.js service uninstall`
removes a previously installed unit or agent.

## Updating

```bash
git pull
npm ci
npm run build
```

Then restart however you're running the process: re-run `npm start` in the
foreground, or restart the service (`systemctl --user restart
garbanzo.service` on Linux; unload and reload the launchd agent on macOS).

> Coming soon: once `garbanzo-bot` is published to npm, updating an
> installed copy will be `npm update -g garbanzo-bot`, or `npx
> garbanzo-bot@latest setup` for a fresh install.

## Backups

Back up the `GARBANZO_HOME` directory (the repo checkout, on this path) the
same way you'd back up the Docker volumes: the SQLite database and its
snapshots (`data/`), runtime config (`config/*.json`), the env files
(`.env`, `.env.<platform>`, which hold secrets), and, if you're running
WhatsApp, `baileys_auth/` (losing it means re-scanning the login QR code).
[docs/BACKUPS.md](BACKUPS.md) describes what belongs in each archive, how
verification and retention work, and how to restore; its automation targets
Docker volumes, so on this path copy the equivalent directories off-machine
on your own schedule (cron, a system timer, or similar).

## What you give up vs Docker

- **Monitoring**: Prometheus and Grafana are a Compose stack; the wizard
  skips the prompt entirely on this path.
- **RabbitMQ bridging transport**: the `amqp` transport needs the Compose
  `broker` profile. Two-instance bridging still works over the `http`
  transport without Docker; see [docs/BRIDGING.md](BRIDGING.md).
- **Container isolation**: the process runs directly on the host with
  whatever privileges you start it with, and optional binaries (ffmpeg,
  yt-dlp, piper, a Whisper sidecar) install into the host rather than a
  sandboxed image layer.
- **Qdrant semantic memory**: this path defaults to `VECTOR_STORE=none`
  (keyword-only). You can still point `VECTOR_STORE=qdrant` and `QDRANT_URL`
  at a Qdrant instance you run yourself; see
  [docs/CONFIGURATION.md](CONFIGURATION.md).

## Troubleshooting

```bash
node dist/cli.js doctor
```

(`garbanzo doctor` once the package is published or linked globally.) It
reports: your Node version against the required range, the resolved
`GARBANZO_HOME` mode and path, which config files exist, which optional
binaries are on `PATH` (ffmpeg, yt-dlp, piper), which provider keys are set
(never their values), whether the configured health port is free, and how
your version compares to the latest release on npm (skipped when offline).

## WhatsApp on this path

WhatsApp works the same way it does under Docker. Login uses the same
browser-based flow described in [docs/PLATFORMS.md](PLATFORMS.md); linked
device auth state lands in `<GARBANZO_HOME>/baileys_auth` (the repo root, on
this path). WhatsApp runs on Baileys, an unofficial WhatsApp Web API, and the
account-risk caveat applies exactly as it does on Docker: keep the outbound
safety layer enabled and avoid high-volume sends on new accounts. See
[docs/ADR-0001-whatsapp-outbound-safety.md](ADR-0001-whatsapp-outbound-safety.md).

## More

- [docs/CONFIGURATION.md](CONFIGURATION.md): environment variable reference.
- [docs/MONITORING.md](MONITORING.md): Prometheus and Grafana, Docker
  Compose only.
- [docs/BRIDGING.md](BRIDGING.md): cross-instance bridging, including the
  two-instance `http` transport that works without Docker.
- [docs/SETUP_EXAMPLES.md](SETUP_EXAMPLES.md): non-interactive wizard flag
  examples, including a native Discord example.
- [docs/PLATFORMS.md](PLATFORMS.md): platform-specific login and setup
  details.
