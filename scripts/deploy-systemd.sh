#!/usr/bin/env bash
set -euo pipefail

# Invoked by CI over host-key-verified SSH. Never rebuild the live release.
# Operator setup and recovery: docs/RELEASE.md.
repo="${1:?source checkout required}"
revision="${2:?validated commit required}"
service="${3:?systemd service required}"
current="${4:?current release symlink required}"
health_origin="${5:?health origin required}"
backup_script="${6:?absolute backup script required}"
web_api="${7:?web API origin required}"

[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full validated commit SHA.' >&2; exit 2; }
[[ "$service" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo 'Invalid systemd service name.' >&2; exit 2; }
[[ "$repo" == /* && -d "$repo/.git" ]] || { echo 'Source checkout must be an absolute Git directory.' >&2; exit 2; }
[[ "$current" == /* && -L "$current" && -d "$current" ]] || { echo 'Prepare the current-release symlink before enabling deployment.' >&2; exit 2; }
[[ "$backup_script" == /* && -x "$backup_script" ]] || { echo 'A working executable backup script is required.' >&2; exit 2; }
[[ "$health_origin" == https://* || "$health_origin" == http://127.0.0.1:* || "$health_origin" == http://localhost:* ]] || { echo 'Use HTTPS or a local health origin.' >&2; exit 2; }

# One activation at a time even across workflow runs or manual invocations.
exec 9>"$repo/.git/vyuha-deploy.lock"
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
working_directory="$(systemctl show "$service" --property=WorkingDirectory --value)"
[[ "$working_directory" == "$current" || "$working_directory" == "$current/"* ]] || {
  echo 'Systemd WorkingDirectory must use the configured current-release symlink.' >&2; exit 2;
}
[[ "$(systemctl show "$service" --property=EnvironmentFiles --value)" == *"$current/.env.release"* ]] || {
  echo 'Systemd must load EnvironmentFile=<current>/.env.release for the runtime build stamp.' >&2; exit 2;
}
api_user="$(systemctl show "$service" --property=User --value)"
api_user="${api_user:-root}"
api_group="$(systemctl show "$service" --property=Group --value)"
api_group="${api_group:-$(id -gn "$api_user")}"

cd "$repo"
git fetch --no-tags origin "$revision"
git cat-file -e "$revision^{commit}"
release_parent="$(dirname "$current")/releases"
mkdir -p "$release_parent"
release="$(mktemp -d "$release_parent/$revision.XXXXXXXX")"
# mktemp creates 0700 directories. Permit the separate API/static users to
# traverse releases; configuration remains restricted to the API group.
chmod 755 "$release_parent" "$release"
git worktree add --detach "$release" "$revision"
[[ "$(git -C "$release" rev-parse HEAD)" == "$revision" ]]

# Copy only server configuration, never build outputs or node_modules.
for env_relative in .env apps/api/.env; do
  if [[ -f "$repo/$env_relative" ]]; then
    install -m 640 -g "$api_group" "$repo/$env_relative" "$release/$env_relative"
  fi
done
[[ -f "$release/.env" || -f "$release/apps/api/.env" ]] || { echo 'No server environment configured.' >&2; exit 2; }
cd "$release"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || { echo 'Deploy with Node 22, matching CI and Docker.' >&2; exit 2; }
[[ "$(pnpm --version)" == 10.33.2 ]] || { echo 'Deploy with pnpm 10.33.2.' >&2; exit 2; }
pnpm install --frozen-lockfile
export GIT_COMMIT="$revision"
export BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export APP_VERSION="$(node -p 'require("./package.json").version')"
printf 'GIT_COMMIT=%s\nBUILT_AT=%s\nAPP_VERSION=%s\n' "$GIT_COMMIT" "$BUILT_AT" "$APP_VERSION" > .env.release
chgrp "$api_group" .env.release
chmod 640 .env.release
VITE_API_BASE_URL="$web_api" NODE_ENV=production pnpm build

# The API and static server must both resolve through `current`. Preserve
# old hashed web assets for clients still using the previous document.
if [[ -d "$current/apps/web/dist/assets" ]]; then
  cp -an "$current/apps/web/dist/assets/." "$release/apps/web/dist/assets/"
fi

previous="$(readlink "$current")"
phase='stopping API'
trap 'echo "Deployment failed during $phase. Previous release: $previous. Do not restore or roll back a migrated schema automatically; follow docs/RELEASE.md." >&2' ERR
sudo systemctl stop "$service"
phase='pre-migration backup (API stopped)'
"$backup_script"
phase='migration'
pnpm --filter @vyuha/api db:migrate
phase='atomic activation'
pending="$current.next.$$"
ln -s "$release" "$pending"
mv -Tf "$pending" "$current"
sudo systemctl start "$service"
phase='readiness and revision verification'
node scripts/verify-release.mjs "$health_origin" "$revision"
trap - ERR
echo "Verified release $revision. Previous release retained at $previous."
