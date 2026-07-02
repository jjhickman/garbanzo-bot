# Backups
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Losing the Docker volumes means re-linking WhatsApp **and** losing the
community database. Two layers protect against that:

| Layer | What | Where | Cadence |
|---|---|---|---|
| In-app | WAL-safe `VACUUM INTO` SQLite snapshots (7 kept) | `data/backups/` *inside* the data volume | daily 04:00 |
| Host | Full archive of **both** volumes (auth + data) with verification and retention | external disk (e.g. USB SSD) | daily 03:30 (systemd timer) |

The in-app layer alone does not survive SD-card/volume loss — the host layer
is what gets everything off the machine's primary storage.

## What the host archive contains

`garbanzo-backup-<stamp>.tar.gz` + `.sha256`:

- `backup/auth/` — Baileys WhatsApp credentials (`creds.json`, signal keys).
  Restoring this avoids re-scanning the QR code.
- `backup/data/` — `garbanzo.db` (+ `-wal`/`-shm`), the app's snapshot
  directory `data/backups/` (including a fresh `garbanzo-prebackup.db`
  taken via `VACUUM INTO` at backup time), and `whatsapp-antiban-state.json`.
- `data/voices/` (Piper TTS models) is **excluded** by default — the models
  are re-downloadable. Set `INCLUDE_VOICES=1` to include them.

## Setup (once, on the host)

```bash
# install nightly timer targeting the external disk
sudo bash scripts/host/backup-install.sh --dest /media/josh/T9/garbanzo-backups

# run one immediately and watch it
sudo systemctl start garbanzo-backup.service
journalctl -u garbanzo-backup.service -n 50
```

Defaults: 03:30 daily, `Persistent=true` (missed runs execute at next boot),
30 daily archives kept plus the first archive of each month for 12 months.
Override via `/etc/default/garbanzo-backup` (`BACKUP_DEST`, `KEEP_DAILY`,
`KEEP_MONTHLY`, `INCLUDE_VOICES`, …).

### Make the external disk mount at boot

Desktop automounts (`/media/<user>/<label>`) only appear after a GUI login —
on a headless Pi the disk may be absent after a reboot, and the backup
script will then **fail loudly** rather than filling the root filesystem.
Give the disk a permanent mount:

```bash
sudo blkid /dev/sda2                       # copy the UUID
sudo mkdir -p /media/josh/T9
echo 'UUID=<uuid>  /media/josh/T9  exfat  defaults,nofail,uid=1000,gid=1000  0  0' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

`nofail` keeps boot healthy when the disk is unplugged.

## Manual runs

```bash
npm run backup:run        # or: bash scripts/host/garbanzo-backup.sh
npm run backup:list       # list archives on the destination
```

## Restore

```bash
docker compose down                         # never `down -v`
bash scripts/host/garbanzo-restore.sh latest
docker compose up -d
```

- Restore a specific archive: pass its filename instead of `latest`.
- If the live DB in the archive is suspect (e.g. you're restoring *because*
  of corruption), add `--promote-snapshot` to replace `garbanzo.db` with the
  newest `VACUUM`'d snapshot from `data/backups/`.
- Checksums are verified automatically when the `.sha256` sidecar is present.

## Monitoring

- `systemctl list-timers garbanzo-backup.timer` — next scheduled run.
- `systemctl status garbanzo-backup.service` — last result; a missing disk
  or failed verification exits non-zero, so failures are visible here and in
  `journalctl`.
- Verification per run: gzip integrity + archive must contain
  `data/garbanzo.db` (warns if WhatsApp `creds.json` is absent, i.e. not linked).

## Off-site (optional)

The archives are plain files — sync `BACKUP_DEST` anywhere
(`rclone sync /media/josh/T9/garbanzo-backups remote:garbanzo-backups`).
Note the auth directory grants control of the linked WhatsApp account:
encrypt before syncing to third-party storage (`rclone` crypt remote or
`age`/`gpg` on the archive).
