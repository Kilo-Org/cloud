#!/usr/bin/env bash
# The local e2e of contract §10 step 5: `wrangler dev` with the real Worker, object and container,
# the fake STS (test/fixtures/e2e/fake-sts.ts) and a fake GitHub (fake-github.mjs) over scratch git
# repositories, against supabase/postgres:15.8.1.135 with TLS in member mode. Needs Docker, git,
# openssl and the workspace's node_modules. Work files live in $E2E (default ~/mp-e2e).
#   run.sh setup                         certificates, database, login, image, repositories
#   run.sh dev <leg> <port> <db> <baseline sha> <github port>
#   run.sh post <port> <sha> <runId> <attempt>
#   run.sh get <port> <runId>
#   run.sh teardown
set -euo pipefail

SERVICE="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(cd "$SERVICE/../.." && pwd)"
FIXTURE="$SERVICE/test/fixtures/e2e"
E2E="${E2E:-$HOME/mp-e2e}"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.135}"
DB=mp-e2e-db
HOST_IP="$(hostname -I | awk '{print $1}')"
MIGRATIONS=packages/db/src/migrations
CODEOWNERS='/packages/db/src/migrations/ @eshurakov @iscekic @chrarnoldus @johnnyeric'

psql_admin() { docker exec -i "$DB" psql -h 127.0.0.1 -U supabase_admin -d "${2:-postgres}" -v ON_ERROR_STOP=1 -Atc "$1"; }

journal() { # journal <tag>...: entries one second apart, in order
  local idx=0 entries=()
  for tag in "$@"; do
    entries+=("{\"idx\":$idx,\"version\":\"7\",\"when\":$((1900000000000 + idx * 1000)),\"tag\":\"$tag\",\"breakpoints\":true}")
    idx=$((idx + 1))
  done
  local IFS=,
  printf '{"version":"7","dialect":"postgresql","entries":[%s]}\n' "${entries[*]}"
}

commit_all() { git -C "$1" add -A && git -C "$1" -c user.email=e2e@test -c user.name=e2e commit -qm "$2" && git -C "$1" rev-parse HEAD; }

setup() {
  mkdir -p "$E2E"
  cd "$E2E"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Migration proxy e2e CA' \
    -keyout ca.key -out ca.pem -addext basicConstraints=critical,CA:TRUE 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST_IP" -keyout server.key -out server.csr 2>/dev/null
  printf 'subjectAltName=IP:%s\nbasicConstraints=CA:FALSE\n' "$HOST_IP" > server.ext
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -out server.crt -extfile server.ext 2>/dev/null
  openssl genrsa -traditional -out app-key.pem 2048 2>/dev/null
  head -c 36 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48 > db-password
  head -c 36 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48 > admin-password

  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker run -d --name "$DB" -p 5432:5432 -e POSTGRES_PASSWORD="$(cat admin-password)" -v "$E2E:/certs-src:ro" \
    --entrypoint bash "$IMAGE" -c 'mkdir -p /certs && cp /certs-src/server.crt /certs-src/server.key /certs/ && chown postgres /certs/* && chmod 600 /certs/server.key && exec docker-entrypoint.sh postgres -D /etc/postgresql -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key' >/dev/null
  for _ in $(seq 1 120); do
    psql_admin "SELECT 1 FROM pg_roles WHERE rolname = 'authenticator'" 2>/dev/null | grep -q 1 && break
    sleep 2
  done
  sleep 5
  docker exec -i -e MIGRATION_PROXY_DB_PASSWORD="$(cat db-password)" "$DB" \
    psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -v block=create -At -f - < "$SERVICE/sql/setup-login.sql"
  psql_admin "ALTER ROLE postgres PASSWORD '$(cat admin-password)'"
  for db in e2e_main e2e_long diff_proxy diff_drizzle; do psql_admin "CREATE DATABASE $db OWNER postgres"; done

  docker build -q -t migration-proxy-e2e-base "$SERVICE/container" >/dev/null
  printf 'FROM migration-proxy-e2e-base\nCOPY ca.pem /app/ca-bundle.pem\n' > "$FIXTURE/Dockerfile"
  cp ca.pem "$FIXTURE/ca.pem"
  {
    printf 'FAKE_DB_PASSWORD="%s"\n' "$(cat db-password)"
    printf 'FAKE_APP_KEY="%s"\n' "$(awk '{printf "%s\\n", $0}' app-key.pem)"
  } > "$FIXTURE/.dev.vars"

  # The scenario repository: a root without migrations (every leg's review base, since each leg's
  # database starts empty), a base, then one commit per leg.
  rm -rf repo-main && mkdir -p repo-main/.github "repo-main/$MIGRATIONS/meta" && git -C repo-main init -q -b main
  echo "$CODEOWNERS" > repo-main/.github/CODEOWNERS
  echo "root=$(commit_all repo-main root)" > shas
  echo 'CREATE TABLE "widgets" ("id" serial PRIMARY KEY, "x" integer);' > "repo-main/$MIGRATIONS/0000_widgets.sql"
  journal 0000_widgets > "repo-main/$MIGRATIONS/meta/_journal.json"
  echo "base=$(commit_all repo-main base)" >> shas
  printf 'COMMIT;\n--> statement-breakpoint\nSET statement_timeout = 0;\n--> statement-breakpoint\nDROP INDEX CONCURRENTLY IF EXISTS "widgets_x_idx";\n--> statement-breakpoint\nCREATE INDEX CONCURRENTLY "widgets_x_idx" ON "widgets" USING btree ("x");\n--> statement-breakpoint\nRESET statement_timeout;\n--> statement-breakpoint\nBEGIN;\n' \
    > "repo-main/$MIGRATIONS/0001_widgets_x.sql"
  journal 0000_widgets 0001_widgets_x > "repo-main/$MIGRATIONS/meta/_journal.json"
  echo "full=$(commit_all repo-main full)" >> shas
  printf 'SET statement_timeout = 0;\n--> statement-breakpoint\nSELECT pg_sleep(1200);\n' > "repo-main/$MIGRATIONS/0002_sleep_1200.sql"
  journal 0000_widgets 0001_widgets_x 0002_sleep_1200 > "repo-main/$MIGRATIONS/meta/_journal.json"
  echo "long=$(commit_all repo-main long)" >> shas
  printf 'SET statement_timeout = 0;\n--> statement-breakpoint\nSELECT pg_sleep(90);\n' > "repo-main/$MIGRATIONS/0003_sleep_90.sql"
  journal 0000_widgets 0001_widgets_x 0002_sleep_1200 0003_sleep_90 > "repo-main/$MIGRATIONS/meta/_journal.json"
  echo "kill=$(commit_all repo-main kill)" >> shas

  # The differential repository: no migrations, then the repository's real folder.
  rm -rf repo-diff && mkdir -p repo-diff/.github && git -C repo-diff init -q -b main
  echo "$CODEOWNERS" > repo-diff/.github/CODEOWNERS
  echo "diff_base=$(commit_all repo-diff base)" >> shas
  mkdir -p "repo-diff/$MIGRATIONS" && cp -R "$ROOT/$MIGRATIONS/." "repo-diff/$MIGRATIONS/"
  echo "diff=$(commit_all repo-diff migrations)" >> shas
  cat shas
}

# Each leg runs its own session under its own Worker name: the container's Docker name derives from
# the Worker name and the object id, and every leg's object is `runs`.
dev() { # dev <leg> <port> <db> <baseline> <github port>
  local leg="$1" port="$2" db="$3" baseline="$4" github="$5"
  cd "$FIXTURE"
  nohup "$SERVICE/node_modules/.bin/wrangler" dev -c wrangler.jsonc -c fake-sts.wrangler.jsonc \
    --name "migration-proxy-local-$leg" \
    --port "$port" --inspector-port "$((port + 1000))" --persist-to "$E2E/state-$leg" \
    --var "MIGRATION_DB_TARGET:$HOST_IP:5432/$db" --var "MIGRATION_REVIEW_BASELINE_SHA:$baseline" \
    --var "MIGRATION_PROXY_GITHUB_API_URL:http://127.0.0.1:$github" > "$E2E/dev-$leg.log" 2>&1 &
  echo "wrangler dev $leg on $port (pid $!), log $E2E/dev-$leg.log"
}

post() { curl -sS -X POST "http://127.0.0.1:$1/v1/runs" -H "Authorization: Bearer $2:$3:$4" -H 'Content-Type: application/json' -d "{\"sha\":\"$2\"}"; echo; }
get() { curl -sS "http://127.0.0.1:$1/v1/runs/$2" -H "Authorization: Bearer $(grep -m1 '^base=' "$E2E/shas" | cut -d= -f2):9999:1"; echo; }

teardown() {
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker rmi -f migration-proxy-e2e-base >/dev/null 2>&1 || true
  rm -f "$FIXTURE/Dockerfile" "$FIXTURE/ca.pem" "$FIXTURE/.dev.vars"
}

"$@"
