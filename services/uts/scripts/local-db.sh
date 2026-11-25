#!/usr/bin/env bash
# Local identity-store Postgres for development and tests.
#
#   scripts/local-db.sh up     start the container, create the admin login and the `uts` database
#   scripts/local-db.sh down   remove the container
#
# The image is pinned to Postgres 17.12, the release that the Supabase identity-store project runs
# (Supabase Postgres 17). The admin login mirrors Supabase's `postgres` login: CREATEROLE and
# CREATEDB but not SUPERUSER, so the migrations prove they need no superuser. Every password here
# is a synthetic local value.
set -euo pipefail

container="${UTS_PG_CONTAINER:-uts-store-postgres}"
port="${UTS_PG_PORT:-55432}"
image="postgres:17.12"
superuser_password="uts-local-superuser"

case "${1:-}" in
  up)
    if docker container inspect "$container" >/dev/null 2>&1; then
      running_image="$(docker container inspect --format '{{.Config.Image}}' "$container")"
      if [[ "$running_image" != "$image" ]]; then
        echo "$container runs $running_image, not $image; run '$0 down' first" >&2
        exit 1
      fi
    else
      docker run --detach --name "$container" \
        --publish "127.0.0.1:${port}:5432" \
        --env POSTGRES_PASSWORD="$superuser_password" \
        "$image" -c max_connections=200 >/dev/null
    fi
    docker start "$container" >/dev/null
    # The image's first-boot server listens only on its socket, so wait for TCP.
    until docker exec "$container" pg_isready --quiet --host 127.0.0.1 --username postgres; do
      sleep 0.5
    done
    docker exec --interactive "$container" \
      psql --quiet --set ON_ERROR_STOP=1 --host 127.0.0.1 --username postgres <<'SQL'
SELECT 'CREATE ROLE uts_admin LOGIN CREATEROLE CREATEDB PASSWORD ''uts-local-admin'''
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_admin')
\gexec
SELECT 'CREATE DATABASE uts OWNER uts_admin'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'uts')
\gexec
SQL
    echo "UTS_MIGRATION_DATABASE_URL=postgres://uts_admin:uts-local-admin@127.0.0.1:${port}/uts"
    ;;
  down)
    docker rm --force "$container" >/dev/null
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
