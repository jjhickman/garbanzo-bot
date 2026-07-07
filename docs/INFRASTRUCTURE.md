# Infrastructure Reference
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Practical guidance for hosting Garbanzo on your own hardware. Everything here
generalizes: hosts, ports, addresses, and monitor tools in the examples are
placeholders for whatever your deployment uses.

## Deployment Targets

Garbanzo runs anywhere Docker runs. Common shapes:

- A small always-on box (single-board computer, mini PC, NUC, or repurposed
  laptop) running the full Compose stack.
- A VM or cloud instance (see [AWS.md](AWS.md) for one worked cloud path).
- A Kubernetes cluster using the Helm chart
  ([deploy/helm/README.md](../deploy/helm/README.md)).

One host can run several bot instances alongside the shared services. Size
memory to the sum of your enabled profiles rather than to any single service.

## Baseline Services

The Compose stack starts only what your `COMPOSE_PROFILES` selects. Each
messaging instance serves its health endpoints on its configured
`HEALTH_PORT`. Supporting services (vector store, metrics, dashboards, message
broker, optional speech services) stay on the internal Compose network unless
you publish them.

Bind addresses matter more than port numbers:

- `127.0.0.1` binds keep an endpoint host-local.
- `0.0.0.0` binds expose it to your network; do this only for endpoints you
  intend other machines to reach, and firewall them (see below).

## Docker Reference

```bash
# Start the selected profiles
docker compose up -d

# Check a messaging instance (use its configured HEALTH_PORT)
curl http://127.0.0.1:<health-port>/health

# Follow logs for one service
docker compose logs -f <service>
```

## Updating

```bash
# With APP_VERSION pinned in .env: bump it, then
docker compose pull && docker compose up -d
```

Pinned versions are recommended over `latest` so upgrades happen when you
choose. Release conventions are in [RELEASES.md](RELEASES.md).

## Local Model Provider (optional)

Simple queries can route to any OpenAI API-compatible model provider instead
of a cloud provider, including one running on the same host or elsewhere on
your network. Point the base URL at your provider and pick a model sized to
your hardware; small models handle short conversational queries well.

Two placement notes:

- A provider on the Docker host is reachable from containers at
  `http://host.docker.internal:<port>` (the Compose file maps the host
  gateway).
- A provider bound only to localhost on another machine will not be reachable;
  bind it to a network interface you control and firewall it.

If no local provider is configured or reachable, routing falls back to the
configured cloud order. Nothing breaks when it is absent.

## Storage & Backups

- State lives in named Docker volumes (databases, messaging auth, vectors,
  dashboards). Never run `docker compose down -v` on a deployment you care
  about.
- Flash storage (SD cards, eMMC) wears under constant writes; prefer an SSD
  for long-lived hosts, and keep off-machine backups regardless.
- Nightly verified backups with restore steps are covered in
  [BACKUPS.md](BACKUPS.md).

## Capacity Planning

- Each messaging instance is single-process and modest: memory limits in the
  Compose file are the practical envelope.
- The vector store and dashboards are the next largest consumers; a broker
  (if you enable the profile) adds its own baseline.
- When one host stops being enough, see [SCALING.md](SCALING.md) for the
  multi-instance model and the thresholds where an orchestrator earns its
  overhead.

## Operator Checklist

- [ ] `COMPOSE_PROFILES` matches what you intend to run.
- [ ] `APP_VERSION` pinned.
- [ ] `MONITORING_TOKEN` set if metrics, dashboards, or `/admin` are enabled.
- [ ] Volumes backed up off-machine on a schedule.
- [ ] Only intentionally-published ports reachable from your network.
- [ ] A health monitor watching each instance (below).

## Health Monitoring

Every messaging instance exposes:

- `/health` - process status, connection state, and staleness as JSON.
- `/health/ready` - returns non-200 the moment the platform connection drops,
  which makes it the right target for alerting.

Configure an HTTP monitor to check the active platform:

- URL: `http://<host>:<health-port>/health/ready` for each instance you run.
- Method: GET, expecting HTTP 200.

Recommended monitor settings:

- Interval around 60 seconds with a few retries before alerting, so brief
  reconnects do not page you.
- One monitor per instance; name them by instance so alerts identify which
  bot dropped.

Any HTTP monitor works (Uptime Kuma, Gatus, healthchecks.io, or your existing
observability stack). If the monitor runs on another machine, publish the
health ports on a network-reachable bind and restrict who can reach them:

```bash
# Allow health monitoring from your monitoring host only
sudo iptables -I DOCKER-USER 1 -i <lan-iface> -p tcp -s <monitor-ip> --dport <health-port> -j ACCEPT

# Drop other hosts on that port
sudo iptables -I DOCKER-USER 2 -i <lan-iface> -p tcp --dport <health-port> -j DROP
```

Repeat per published health port. Prometheus and Grafana specifics, including
the dashboard and scrape auth, live in [MONITORING.md](MONITORING.md).
