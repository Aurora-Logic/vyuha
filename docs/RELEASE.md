# Releasing

How a version is cut, what stamps the build, and how to get back if it is
wrong. `RUNBOOK.md` covers running the system day to day; this covers changing
which version is running.

## What a version means here

Semver, one minor per delivery phase.

| Change | Version |
|---|---|
| A phase closes (6a, 6b, 7a) | minor — `1.1.0`, `1.2.0` |
| A fix on a released phase | patch — `1.1.1` |
| A break in the API contract, or a migration that cannot be reversed | major |

`package.json` is the only place the number lives. The in-app changelog
(`apps/web/src/features/updates/changelog.ts`) names the same version, and the
git tag is `v` plus that number. If the three ever disagree, package.json is
right and the other two are stale.

**They disagree today.** package.json now says `1.0.0`, matching the only tag
ever cut (`v1.0.0-attendance`); the changelog's newest entry is `0.9.0`,
because 1.0.0 shipped without one. Phase 6a is `1.1.0` and closing it is the
moment to write both entries — 1.0.0 from its commits, and 1.1.0 from these.
Nobody should invent the 1.0.0 entry from memory; the commits between
`v1.0.0-attendance` and the 0.9.0 entry are what it says.

## What identifies a build

Three facts, each from the build rather than from someone typing it:

- **version** — `package.json`
- **commit** — `GIT_COMMIT`, exported by the release
- **built at** — `BUILT_AT`, exported by the release

Readable in two places without shell access:

```
GET /api/v1/health          -> { "version": "1.1.0", "commit": "a3f91c2", "builtAt": "..." }
Updates screen in the app   -> 1.1.0+a3f91c2 . built 23-08-2026
```

A build that was not stamped says `dev` or `unknown`. That is deliberate: a
wrong commit sends whoever is debugging to the wrong diff, and an honest
"unknown" costs one question instead of an hour.

## Cutting a release

1. **Green first.** Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`, and obtain CI
   green on the branch. Per CLAUDE.md section 5, `/ultrareview` before a phase
   closes.
2. **Bump** the version in every `package.json` (root, `apps/*`, `packages/*`).
   They move together.
3. **Write the changelog entry** in `changelog.ts` with the same version and the
   REQ IDs the commits already carry. It ships with the code; it is not seed
   data.
4. **Commit** `Release 1.1.0` and merge to `main`.
5. **Tag** the merge commit:
   ```
   git tag -a v1.1.0 -m "Phase 6a"
   git push origin v1.1.0
   ```
6. **Build and deploy**, stamping the build:
   ```
   export APP_VERSION=$(node -p "require('./package.json').version")
   export GIT_COMMIT=$(git rev-parse --short HEAD)
   export BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   docker compose -f docker/docker-compose.prod.yml build
   docker compose -f docker/docker-compose.prod.yml up -d
   ```
7. **Verify what landed** — not that the deploy command exited zero:
   ```
   curl -s https://app.gc-communication.in/api/v1/health | jq '{version, commit}'
   ```
   The commit must equal the tag's. If it does not, the deploy served a cached
   image and step 6 has to be repeated with `--no-cache`.

## Rolling back

The database is the constraint, not the images. Images are disposable; a
migration that has run is not.

**If no migration ran in the release** — the common case — check out the
previous tag and repeat step 6 with it:

```
git checkout v1.0.0
export APP_VERSION=$(node -p "require('./package.json').version")
export GIT_COMMIT=$(git rev-parse --short HEAD)
export BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f docker/docker-compose.prod.yml build
docker compose -f docker/docker-compose.prod.yml up -d
```

Then verify with the health check that the commit is the old one.

**If a migration ran**, do not put the old code on the new schema and hope.
Migrations in this repo are forward-only (`apps/api/drizzle/README.md`,
`platform/db/migrate.ts`); there is no down migration to run, and this
document used to say there was. The two real paths are:

1. **Roll forward.** Fix the code against the new schema and deploy that. For
   a migration that only added -- a column, an index, a table -- this is
   nearly always right, because the old code ignores what it does not know.
2. **Restore.** For a migration that changed or removed something the old
   code needs: `docker/backup.sh` should already have run before the release;
   restore it with `docker/restore.sh`, then put the old tag back, and accept
   the data written between the backup and now.

```
docker/backup.sh
# Only with an explicitly approved loss-of-post-backup-writes recovery decision:
docker compose --env-file .env.production -f docker/docker-compose.prod.yml stop api
VYUHA_RESTORE_OVER_LIVE=yes docker/restore.sh <pre-release-backup.dump> <actual-live-db-name>
docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d  # with the compatible release
```

Deploys now build before they migrate, so a build that fails leaves the old
code on the old schema and none of this is needed.

## Hardened systemd CI deployment (operator setup required)

The workflow no longer builds inside the live checkout or deploys a moving `main` tip. It passes the full checked `github.sha` to `scripts/deploy-systemd.sh`, builds a detached worktree, stops API writers, requires a successful backup, applies migrations, switches the prepared release symlink atomically, starts the API and verifies both readiness and the full runtime revision. Failed phases exit nonzero; old releases are retained. A migration failure never triggers an automatic destructive restore or an unverified code downgrade.

This is a deliberate deployment-layout change and **must not be enabled until staging has rehearsed it**. No production unit, symlink or secret is changed by editing this repository.

Operator requirements:

- Install Node 22 and pnpm 10.33.2 for the SSH user's login shell; CI and the Docker API use Node 22.
- Keep `SSH_DIR` as a control checkout with its `.env` / `apps/api/.env` and Git origin access. Builds go into a sibling `releases/` directory, not into this checkout.
- Prepare `CURRENT_RELEASE_LINK`, an absolute symlink to an existing valid release. Configure both the static server root and systemd `WorkingDirectory`/`ExecStart` through this link. Do not repoint live paths without a reviewed migration/recovery plan.
- Add `EnvironmentFile=-<CURRENT_RELEASE_LINK>/.env.release` to the systemd unit. This generated file carries the exact revision, build time and version. Existing unit environment must not override those values.
- Verify traversal/read access as the actual API and static-server users in staging. Release directories are 0755; copied environments are 0640 in the systemd API service's group. The deployer needs permission to assign that group. Keep the static-server user out of the API secrets group and deny dotfiles in the static web root.
- Configure the `production` GitHub environment with required reviewers. Existing SSH secrets remain, plus `SSH_KNOWN_HOSTS` (host keys independently verified with the server operator), `CURRENT_RELEASE_LINK`, `HEALTH_ORIGIN`, and `BACKUP_SCRIPT`.
- `BACKUP_SCRIPT` is an absolute executable, uses the real deployment's database credentials/configuration, verifies the archive, copies it to the approved off-host destination, and exits nonzero on any failure. A Docker backup script is not automatically suitable for a host-managed database. CI stops the API before invoking it; identify and stop any other writers too.
- Grant only the required systemd stop/start permissions. The workflow uses native OpenSSH with strict host-key verification, no auto-trusted `ssh-keyscan` and no downloaded SSH helper action.
- Rehearse a backup restore into a **new named scratch database**, e.g. `docker/restore.sh <dump> vyuha_restore_rehearsal --compare vyuha` for the Docker topology. Compare against a stable/quiesced source, record results, then remove only that verified scratch database.
- If backup fails, the old code/schema remain, but the API is stopped: inspect the cause and deliberately restart the old service. If migration/activation/readiness fails, inspect the recorded phase and schema state before choosing a forward fix or approved recovery.

Validation in this repository is not evidence that these production requirements are configured. Track staging activation, a wrong-revision readiness refusal, and a restore drill before release approval.

## Isolated test runs

`pnpm --filter @vyuha/api test [test files]` now creates a unique database on the local development Postgres (loopback port 55432), migrates it, runs Vitest with a unique queue prefix and removes that database after completion. It refuses remote/production hosts. The development role needs CREATEDB. A killed process or leaked connection may leave a clearly named `vyuha_test_<random>` scratch database; inspect ownership/connections before removing it. Direct `vitest` invocation is diagnostic-only and does not provide this isolation.

## Roll forward instead, where you can

A patch release is usually faster and safer than a rollback: the schema stays
where it is, and the fix is the thing you actually wanted. Roll back when the
release is broadly broken or unsafe; roll forward when one thing is wrong.
