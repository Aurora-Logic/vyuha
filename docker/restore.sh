#!/usr/bin/env bash
set -euo pipefail

# Restores a docker/backup.sh dump into a named database on the production
# Postgres, and proves it landed by counting every table's rows (NFR-08: a
# rehearsed restore, not a documented one).
#
#   Rehearsal (monthly, and after any schema change):
#     docker/restore.sh backups/vyuha-<stamp>.dump vyuha_restore_rehearsal --compare vyuha
#       -> restores into a scratch database and diffs its per-table row counts
#          against the live database; exits non-zero on any mismatch.
#       -> drop the scratch afterwards:
#          docker compose ... exec postgres dropdb -U vyuha vyuha_restore_rehearsal
#
#   Disaster recovery (into the live database name):
#     stop the api first, then
#     VYUHA_RESTORE_OVER_LIVE=yes docker/restore.sh <dump> vyuha
#
# Restoring over the live database is refused without that variable: the
# default invocation must never be able to destroy the thing it exists to
# protect.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${VYUHA_ENV_FILE:-$ROOT/.env.production}"
COMPOSE_FILE="${VYUHA_COMPOSE_FILE:-$ROOT/docker/docker-compose.prod.yml}"

usage() {
  echo "usage: docker/restore.sh <dump-file> <target-db> [--compare <db>]" >&2
  exit 2
}

DUMP="${1:-}"
TARGET="${2:-}"
COMPARE=""
if [[ "${3:-}" == "--compare" ]]; then
  COMPARE="${4:-}"
  [[ -n "$COMPARE" ]] || usage
elif [[ -n "${3:-}" ]]; then
  usage
fi
[[ -n "$DUMP" && -n "$TARGET" ]] || usage
# Database names enter SQL/shell commands below: accept identifiers, not syntax.
[[ "$TARGET" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || { echo 'invalid target database identifier' >&2; exit 2; }
[[ -z "$COMPARE" || "$COMPARE" =~ ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$ ]] || { echo 'invalid comparison database identifier' >&2; exit 2; }
[[ -f "$DUMP" ]] || { echo "no such dump: $DUMP" >&2; exit 1; }

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

pg() {
  # Runs as the container's own superuser; no password crosses this script.
  compose exec -T postgres "$@"
}

live_db="$(pg sh -c 'echo "$POSTGRES_DB"' | tr -d '[:space:]')"
if [[ "$TARGET" == "$live_db" && "${VYUHA_RESTORE_OVER_LIVE:-}" != "yes" ]]; then
  echo "refusing to restore over the live database '$live_db'." >&2
  echo "Stop the api, then re-run with VYUHA_RESTORE_OVER_LIVE=yes if this is disaster recovery." >&2
  exit 1
fi

pg sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -tAc \"select 1 from pg_database where datname = '$TARGET'\"" | grep -q 1 \
  || pg sh -c "createdb -U \"\$POSTGRES_USER\" \"$TARGET\""

# --clean --if-exists: a re-run replaces objects instead of erroring on them,
# which is what both the rehearsal and real recovery want. --no-owner because
# the archive may carry a different role name than this box uses. The archive
# arrives on bare stdin -- naming /dev/stdin breaks on the alpine image when
# stdin is a pipe.
pg sh -c "exec pg_restore -U \"\$POSTGRES_USER\" -d \"$TARGET\" --clean --if-exists --no-owner --exit-on-error" \
  < "$DUMP"

# Exact counts, not pg_stat estimates -- the statistics collector has not run
# over a freshly restored database and its numbers would "verify" nothing.
counts() {
  local db="$1"
  local query
  query="$(pg sh -c "psql -U \"\$POSTGRES_USER\" -d \"$db\" -tA -c \"
    select coalesce(string_agg(
      format('select %L || '' '' || count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename),
      ' union all ' order by schemaname, tablename), 'select ''(no tables) 0''')
    from pg_tables
    where schemaname not in ('pg_catalog', 'information_schema')\"")"
  pg sh -c "psql -U \"\$POSTGRES_USER\" -d \"$db\" -tA -c \"$query\"" | sort
}

restored="$(counts "$TARGET")"
tables="$(echo "$restored" | wc -l | tr -d ' ')"
echo "restored $DUMP into '$TARGET' ($tables tables):"
echo "$restored" | sed 's/^/  /'

if [[ -n "$COMPARE" ]]; then
  reference="$(counts "$COMPARE")"
  if [[ "$restored" == "$reference" ]]; then
    echo "row counts match '$COMPARE' across all $tables tables."
  else
    echo "ROW COUNT MISMATCH against '$COMPARE':" >&2
    diff <(echo "$reference") <(echo "$restored") | sed 's/^/  /' >&2 || true
    exit 1
  fi
fi
