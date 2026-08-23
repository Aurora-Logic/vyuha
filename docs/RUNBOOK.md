# Runbook

Running the system day to day. For cutting a version, stamping the build and
getting back from a bad one, see `RELEASE.md`.

One page for whoever is holding the pager. Everything runs from the repo root
on the VPS; every command takes the same two flags, so they are abbreviated:

```bash
alias vy='docker compose --env-file .env.production -f docker/docker-compose.prod.yml'
```

Add `--profile minio` to every `vy` call if object storage is MinIO on this
box rather than R2 (see `.env.production.example`).

## Prerequisites, once

`cp .env.production.example .env.production` and fill every value — the API
validates the lot at boot and refuses to start on a missing one, naming it.
DNS for `DOMAIN` (and `STORAGE_DOMAIN`, if MinIO) points at this box. TLS
needs nothing else; Caddy issues and renews certificates itself.

## Start / deploy

```bash
vy build                                     # build api + web images
vy run --rm api node dist/platform/db/migrate.js   # migrations, forward-only
vy up -d                                     # start (or replace) everything
curl -fsS https://<DOMAIN>/api/v1/ready      # 200 with per-dependency detail
```

Migrations run before `up`, as their own process — never at API boot. The
same four lines are the whole deploy for a new build.

## Stop

```bash
vy down          # stop; data survives in named volumes
vy down -v       # DESTROYS the database, redis and photos. Never casually.
```

## Logs and health

```bash
vy logs -f api           # structured JSON, request ids threaded through
vy logs -f caddy         # access log, certificate events
vy ps                    # health column: api healthcheck is /api/v1/health
curl -fsS https://<DOMAIN>/api/v1/ready   # 503 names the failing dependency
```

## Backup (nightly) and restore

```bash
docker/backup.sh /var/backups/vyuha       # pg_dump -Fc + archive check + prune
crontab: 30 2 * * * /opt/vyuha/docker/backup.sh /var/backups/vyuha
```

Copy dumps off the box in the same cron (rclone/rsync) — a backup on the disk
it protects dies with that disk. Restore rehearsal (monthly, and after any
schema change) into a scratch database, with row counts diffed against live:

```bash
docker/restore.sh /var/backups/vyuha/vyuha-<stamp>.dump vyuha_restore_rehearsal --compare vyuha
vy exec postgres dropdb -U vyuha vyuha_restore_rehearsal
```

Disaster recovery is the same script pointed at the live name — it refuses
unless `VYUHA_RESTORE_OVER_LIVE=yes`, and the api must be stopped first:

```bash
vy stop api && VYUHA_RESTORE_OVER_LIVE=yes docker/restore.sh <dump> vyuha && vy start api
```

## Job monitor

`GET /jobs` (Admin — `settings.manage`) summarises every BullMQ queue: counts
by state, recent failures with reasons. With an Admin access token:

```bash
curl -fsS -H "Authorization: Bearer <token>" https://<DOMAIN>/api/v1/jobs
```

Failed jobs re-run on the scheduler's next sweep; every job is idempotent.
There is deliberately no retry endpoint.

## Error tracking

Deferred — `SENTRY_DSN` is a validated env slot but no SDK is installed
(OPEN-QUESTIONS WS-A-1). Until that decision lands, errors live in
`vy logs api`.
