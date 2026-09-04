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

1. **Green first.** `pnpm --filter '@vyuha/*' typecheck lint test build`, and CI
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
docker/backup.sh                                          # before anything
docker/restore.sh <the pre-release backup>                # only if rolling forward is not possible
docker compose -f docker/docker-compose.prod.yml up -d    # with the old tag
```

Deploys now build before they migrate, so a build that fails leaves the old
code on the old schema and none of this is needed.

## Roll forward instead, where you can

A patch release is usually faster and safer than a rollback: the schema stays
where it is, and the fix is the thing you actually wanted. Roll back when the
release is broadly broken or unsafe; roll forward when one thing is wrong.
