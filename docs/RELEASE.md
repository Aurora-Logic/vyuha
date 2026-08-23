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
Every migration in this repo is written reversible (CLAUDE.md section 4), so
the order is: back up first, run the down migration, then the code.

```
docker/backup.sh                                          # before anything
# apply the reverse of the migration the release added
docker compose -f docker/docker-compose.prod.yml up -d    # with the old tag
```

**If the schema is beyond a down migration** — the case a reversible migration
exists to prevent — restore the nightly backup with `docker/restore.sh` and
accept the data lost between the backup and now. That is the last resort, and
the reason the backup runs nightly.

## Roll forward instead, where you can

A patch release is usually faster and safer than a rollback: the schema stays
where it is, and the fix is the thing you actually wanted. Roll back when the
release is broadly broken or unsafe; roll forward when one thing is wrong.
