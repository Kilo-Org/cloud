#!/usr/bin/env bash
# Local check of the lease SQL (README, "Database leases") against a throwaway PostgreSQL in
# Docker; never against a real database. It mirrors Supabase's roles: the bootstrap superuser is
# `supabase_admin`; `postgres` is a non-superuser CREATEROLE login that owns the database and the
# `public` schema and is a member of pg_signal_backend, pg_monitor and pg_read_all_data; a schema
# `net` stands in for pg_net's PUBLIC grants. It runs setup.sql and setup-replica-sweeper.sql as
# `postgres` and setup-ci-migration.sql as the superuser, then each statement file the way
# Infisical runs it: the template variables filled in, the text split on ';', and every part in
# one transaction, as the dynamic secret's own login. A second container is a streaming hot
# standby of the first, for the replica sweep (design decision Q63). Every password is generated
# here. Exits 1 on the first failure.
#
#   PG_IMAGE=postgres:16 services/sts/sql/leases/check.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${PG_IMAGE:-postgres:16}
PORT=${PG_PORT:-55432}
REPLICA_PORT=${PG_REPLICA_PORT:-$((PORT + 1))}
NAME=sts-lease-sql-check-$PORT
NET=$NAME
DB=postgres
TMP=$(mktemp -d)

secret() { openssl rand -hex 24; }
role_name() { echo "lease_$1_$(openssl rand -hex 10)"; }
SUPER_PW=$(secret)
OWNER_PW=$(secret)
APP_PW=$(secret)
REPLICA_ADMIN_PW=$(secret)
MIGRATION_ADMIN_PW=$(secret)
SWEEPER_PW=$(secret)

pass() { echo "PASS $*"; }
fail() {
  echo "FAIL $*"
  exit 1
}

docker rm -f "$NAME" "$NAME-replica" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker run -d --rm --name "$NAME" --network "$NET" --network-alias primary \
  -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD="$SUPER_PW" -e POSTGRES_DB="$DB" \
  "$IMAGE" >/dev/null
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  docker rm -f "$NAME" "$NAME-replica" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  if PGPASSWORD=$SUPER_PW psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d "$DB" -qtAc 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# The replica: a base backup of the primary over the replication protocol, then a hot standby that
# streams from it (`-R` writes primary_conninfo and standby.signal). Roles, the kilo_lease schema
# and its rows reach it only through replication.
docker exec "$NAME" sh -c 'echo "host replication all all scram-sha-256" >>"$PGDATA/pg_hba.conf"'
PGPASSWORD=$SUPER_PW psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d "$DB" -qtAc 'select pg_reload_conf()' >/dev/null
docker run -d --rm --name "$NAME-replica" --network "$NET" -p "127.0.0.1:$REPLICA_PORT:5432" \
  --user postgres -e PGPASSWORD="$SUPER_PW" --entrypoint bash "$IMAGE" -c \
  'pg_basebackup -h primary -U supabase_admin -D /tmp/standby -R -X stream && chmod 700 /tmp/standby && exec postgres -D /tmp/standby' >/dev/null
for _ in $(seq 1 60); do
  if [ "$(PGPASSWORD=$SUPER_PW psql -h 127.0.0.1 -p "$REPLICA_PORT" -U supabase_admin -d "$DB" -qtAc 'select pg_is_in_recovery()' 2>/dev/null)" = t ]; then
    break
  fi
  sleep 1
done

# psql as one login over TCP with a password, so VALID UNTIL applies.
sql_in() { # database login password sql...
  local db=$1 login=$2 password=$3
  shift 3
  PGPASSWORD=$password psql -h 127.0.0.1 -p "$PORT" -U "$login" -d "$db" -v ON_ERROR_STOP=1 -qtA "$@"
}
sql() { sql_in "$DB" "$@"; }
super() { sql supabase_admin "$SUPER_PW" "$@"; }
owner() { sql postgres "$OWNER_PW" "$@"; }

# Runs one statement file as Infisical does (providers/sql-database.ts): handlebars variables
# filled in, split on ';', empty parts dropped, all parts in one transaction.
infisical() { # login password file username role-password expiration
  local login=$1 password=$2 file=$3 username=$4 role_password=$5 expiration=$6
  local rendered
  rendered=$(sed -e "s/{{username}}/$username/g" -e "s/{{password}}/$role_password/g" \
    -e "s/{{expiration}}/$expiration/g" -e "s/{{database}}/$DB/g" "$file")
  {
    echo 'BEGIN;'
    awk 'BEGIN { RS = ";" } NF { print $0 ";" }' <<<"$rendered"
    echo 'COMMIT;'
  } | sql "$login" "$password" >/dev/null
}
create_replica() { infisical kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$HERE/replica-read.create.sql" "$@"; }
create_migration() { infisical kilo_lease_migration_admin "$MIGRATION_ADMIN_PW" "$HERE/ci-migration.create.sql" "$@"; }
revoke_replica() { infisical kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$HERE/revoke.sql" "$1" unused unused; }
revoke_migration() { infisical kilo_lease_migration_admin "$MIGRATION_ADMIN_PW" "$HERE/revoke.sql" "$1" unused unused; }
replica_admin() { sql kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$@"; }
migration_admin() { sql kilo_lease_migration_admin "$MIGRATION_ADMIN_PW" "$@"; }
expires_in() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%S.000Z; }
role_count() { super -c "select count(*) from pg_roles where rolname = '$1'"; }
sessions_of() { super -c "select count(*) from pg_stat_activity where usename = '$1'"; }
# Client sessions whose role was dropped while they were open.
orphans() { super -c "select count(*) from pg_stat_activity where backend_type = 'client backend' and usesysid is not null and usename is null"; }
can_login() { sql "$1" "$2" -c 'select 1' >/dev/null 2>&1; }
# Starts a session that runs `statements` then sleeps, in this shell so `wait "$SESSION"` can reap
# it. Its output goes to the log file.
open_session() { # login password log [statements]
  PGPASSWORD=$2 psql -h 127.0.0.1 -p "$PORT" -U "$1" -d "$DB" -qtA -c "${4:-select 1}" -c 'select pg_sleep(60)' >"$3" 2>&1 &
  SESSION=$!
}
wait_for_session() { # login
  for _ in $(seq 1 50); do
    [ "$(sessions_of "$1")" -ge 1 ] && return 0
    sleep 0.2
  done
  fail "a session of $1 opened"
}
report() { owner -f "$HERE/report.sql"; }

# The replica, over TCP with a password.
replica_sql() { # login password sql...
  local login=$1 password=$2
  shift 2
  PGPASSWORD=$password psql -h 127.0.0.1 -p "$REPLICA_PORT" -U "$login" -d "$DB" -v ON_ERROR_STOP=1 -qtA "$@"
}
replica_super() { replica_sql supabase_admin "$SUPER_PW" "$@"; }
sweeper() { replica_sql kilo_lease_sweeper "$SWEEPER_PW" "$@"; }
sweep() { sweeper -c 'select kilo_lease.sweep_sessions()'; }
# Waits until the replica has replayed everything the primary wrote so far.
caught_up() {
  local lsn
  lsn=$(super -c 'select pg_current_wal_lsn()')
  for _ in $(seq 1 100); do
    [ "$(replica_super -c "select pg_last_wal_replay_lsn() >= '$lsn'::pg_lsn")" = t ] && return 0
    sleep 0.1
  done
  fail 'the replica caught up with the primary'
}
# Opens an idle session on the replica (it runs one statement, then waits for input), in this
# shell, and sets RPID to its backend pid.
replica_session() { # login password
  local log
  log=$(mktemp -p "$TMP")
  { echo 'select pg_backend_pid();'; sleep 300; } |
    PGPASSWORD=$2 psql -h 127.0.0.1 -p "$REPLICA_PORT" -U "$1" -d "$DB" -qtA >"$log" 2>&1 &
  for _ in $(seq 1 50); do
    RPID=$(head -n 1 "$log" | grep -E '^[0-9]+$' || true)
    [ -n "$RPID" ] && return 0
    sleep 0.2
  done
  fail "a replica session of $1 opened: $(cat "$log")"
}
replica_alive() { [ "$(replica_super -c "select count(*) from pg_stat_activity where pid = $1")" = 1 ]; }
replica_ended() { # pid
  for _ in $(seq 1 50); do
    replica_alive "$1" || return 0
    sleep 0.1
  done
  fail "the replica session $1 ended"
}

echo "PostgreSQL $(super -c 'show server_version')"

# Supabase's shape: `postgres` owns the database, the schema and the application tables, and an
# application pool logs in as its own role. supautils lets `postgres` set the log settings per role;
# `GRANT SET ON PARAMETER` stands in for it.
super -c "create role postgres login createrole password '$OWNER_PW'" \
  -c "alter database $DB owner to postgres" -c 'alter schema public owner to postgres' \
  -c 'grant pg_signal_backend, pg_monitor, pg_read_all_data to postgres' \
  -c 'grant set on parameter log_statement, log_min_duration_statement, log_min_error_statement to postgres' \
  -c "create role app_pool login password '$APP_PW'" >/dev/null
owner -c 'create table public.accounts (id int primary key, email text)' \
  -c "insert into public.accounts values (1, 'a@example.invalid')" \
  -c 'grant select on public.accounts to app_pool' >/dev/null
# Functions a migration could have left in `public`, and a stand-in for pg_net (which Supabase
# installs with USAGE, table rights and EXECUTE for PUBLIC) and for dblink in `extensions`.
owner -c 'create function public.planted_definer() returns int language sql security definer as $$ select 1 $$' \
  -c 'create function public.planted_writer() returns void language sql as $$ delete from public.accounts where false $$' \
  -c 'create function public.planted_reader() returns int language sql stable as $$ select 1 $$' >/dev/null
super -c 'create schema net' -c 'grant usage on schema net to public' \
  -c 'create table net.http_request_queue (id bigint, headers text)' -c 'grant all on net.http_request_queue to public' \
  -c "create function net.http_get(url text) returns text language internal volatile as 'timeofday'" \
  -c 'create schema extensions' -c 'create extension dblink schema extensions' >/dev/null

if owner -c 'create role kilo_probe nologin' -c 'grant postgres to kilo_probe' >/dev/null 2>&1; then
  echo 'INFO the non-superuser owner can grant its own membership on this version'
else
  echo 'INFO the non-superuser owner cannot grant its own membership on this version; setup-ci-migration.sql needs a superuser'
fi
super -c 'drop role if exists kilo_probe' >/dev/null

# Both setup files run with the server at log_statement = ddl: neither admin password may reach the
# server log. The template roles' CREATE ROLE must be there, so the check sees logged DDL.
super -c "alter system set log_statement = 'ddl'" -c 'select pg_reload_conf()' >/dev/null
sleep 1
owner -v replica_admin_password="$REPLICA_ADMIN_PW" -f "$HERE/setup.sql" >"$TMP/setup.out"
pass 'setup.sql ran as postgres'
docker logs "$NAME" >"$TMP/setup.log" 2>&1
grep -qF 'statement: CREATE ROLE kilo_lease_replica_read NOLOGIN' "$TMP/setup.log" ||
  fail 'the server logs the DDL of setup.sql under log_statement = ddl'
if grep -qF "$REPLICA_ADMIN_PW" "$TMP/setup.log"; then fail 'setup.sql keeps the replica admin password out of the server log under log_statement = ddl'; fi
if grep -qF "$REPLICA_ADMIN_PW" "$TMP/setup.out"; then fail 'setup.sql does not print the replica admin password'; fi
pass 'under log_statement = ddl setup.sql keeps the replica admin password out of the server log and its output'
owner -v sweeper_password="$SWEEPER_PW" -f "$HERE/setup-replica-sweeper.sql" >"$TMP/setup-replica-sweeper.out"
docker logs "$NAME" >"$TMP/setup.log" 2>&1
grep -qF 'statement: ALTER TABLE kilo_lease.lease_role ADD COLUMN gone_since timestamptz' "$TMP/setup.log" ||
  fail 'the server logs the DDL of setup-replica-sweeper.sql under log_statement = ddl'
if grep -qF "$SWEEPER_PW" "$TMP/setup.log"; then fail 'setup-replica-sweeper.sql keeps the sweeper password out of the server log under log_statement = ddl'; fi
if grep -qF "$SWEEPER_PW" "$TMP/setup-replica-sweeper.out"; then fail 'setup-replica-sweeper.sql does not print the sweeper password'; fi
pass 'setup-replica-sweeper.sql ran as postgres and, under log_statement = ddl, keeps the sweeper password out of the server log and its output'

# Known limit (README Risks, design decision Q64): `postgres` administers every role it created,
# so it can reset the replica admin's password. An owner role in between would not help: ADMIN
# follows memberships, and only a superuser can remove the creator's implicit grant.
owner -c "alter role kilo_lease_replica_admin password '$REPLICA_ADMIN_PW'" >/dev/null ||
  fail 'postgres can reset the replica admin password after setup.sql (if not, update the README and Q64)'
pass 'KNOWN after setup.sql, postgres can reset the replica admin password'
if owner -v migration_admin_password="$MIGRATION_ADMIN_PW" -f "$HERE/setup-ci-migration.sql" >/dev/null 2>"$TMP/err"; then
  fail 'setup-ci-migration.sql needs a superuser'
fi
super -v migration_admin_password="$MIGRATION_ADMIN_PW" -f "$HERE/setup-ci-migration.sql" >"$TMP/setup-ci-migration.out"
pass 'setup-ci-migration.sql fails as postgres and runs as the superuser'
docker logs "$NAME" >"$TMP/setup.log" 2>&1
super -c "alter system reset log_statement" -c 'select pg_reload_conf()' >/dev/null
grep -qF 'statement: CREATE ROLE kilo_lease_migration NOLOGIN' "$TMP/setup.log" ||
  fail 'the server logs the DDL of setup-ci-migration.sql under log_statement = ddl'
if grep -qF "$MIGRATION_ADMIN_PW" "$TMP/setup.log"; then fail 'setup-ci-migration.sql keeps the migration admin password out of the server log under log_statement = ddl'; fi
if grep -qF "$MIGRATION_ADMIN_PW" "$TMP/setup-ci-migration.out"; then fail 'setup-ci-migration.sql does not print the migration admin password'; fi
pass 'under log_statement = ddl setup-ci-migration.sql keeps the migration admin password out of the server log and its output'
for admin in kilo_lease_replica_admin kilo_lease_migration_admin; do
  if owner -c "alter role $admin password 'reset-by-postgres'" >/dev/null 2>&1; then
    fail "after setup-ci-migration.sql, postgres cannot reset the $admin password"
  fi
done
pass 'after setup-ci-migration.sql, postgres (and so a ci-migration lease) cannot reset either admin password'

# setup-ci-migration.sql gave the kilo_lease schema, table and functions to kilo_lease_owner, so a
# ci-migration lease acting as `postgres` cannot replace create_lease to record later passwords.
[ "$(super -c "select count(*) from pg_proc where pronamespace = 'kilo_lease'::regnamespace and proowner <> 'kilo_lease_owner'::regrole")" = 0 ] ||
  fail 'kilo_lease_owner owns every kilo_lease function'
[ "$(super -c "select pg_has_role('postgres', 'kilo_lease_owner', 'member')")" = f ] || fail 'postgres is not a member of kilo_lease_owner'
if owner -c 'create or replace function kilo_lease.create_lease(username text, password text, valid_until timestamptz) returns void language sql as $$ select $$' >/dev/null 2>"$TMP/err"; then
  fail 'postgres cannot replace kilo_lease.create_lease'
fi
grep -qE 'must be owner|permission denied for schema kilo_lease' "$TMP/err" || fail "replace refused for ownership: $(cat "$TMP/err")"
if owner -c 'create function kilo_lease.planted() returns int language sql as $$ select 1 $$' >/dev/null 2>&1; then
  fail 'postgres cannot add a function to kilo_lease'
fi
if owner -c 'alter function kilo_lease.end_sessions(text) owner to postgres' >/dev/null 2>&1; then
  fail 'postgres cannot take over a kilo_lease function'
fi
pass 'after setup-ci-migration.sql, postgres (and so a ci-migration lease) cannot replace, add or take over a kilo_lease function'

# A ci-migration lease runs as `postgres`, which reads other sessions' query text. Neither admin
# login's statements show there; another login's do.
MARK=$(secret)
PGPASSWORD=$APP_PW psql -h 127.0.0.1 -p "$PORT" -U app_pool -d "$DB" -qtAc "select pg_sleep(2), 'app-$MARK'" >/dev/null 2>&1 &
APP_MARK=$!
PGPASSWORD=$REPLICA_ADMIN_PW psql -h 127.0.0.1 -p "$PORT" -U kilo_lease_replica_admin -d "$DB" -qtAc "select pg_sleep(2), 'replica-$MARK'" >/dev/null 2>&1 &
REPLICA_MARK=$!
PGPASSWORD=$MIGRATION_ADMIN_PW psql -h 127.0.0.1 -p "$PORT" -U kilo_lease_migration_admin -d "$DB" -qtAc "select pg_sleep(2), 'migration-$MARK'" >/dev/null 2>&1 &
MIGRATION_MARK=$!
sleep 1
seen() { owner -c "select count(*) from pg_stat_activity where position('$1-' || '$MARK' in query) > 0"; }
[ "$(seen app)" = 1 ] || fail 'postgres sees the query text of an application session (the check sees tracked text)'
[ "$(seen replica)" = 0 ] || fail 'postgres does not see the query text of a replica admin session'
[ "$(seen migration)" = 0 ] || fail 'postgres does not see the query text of a migration admin session'
wait "$APP_MARK" "$REPLICA_MARK" "$MIGRATION_MARK"
pass 'after setup-ci-migration.sql, postgres (and so a ci-migration lease) cannot read either admin login query text in pg_stat_activity'

# The report: what the replica template reaches through PUBLIC.
expect_row() { grep -qxF "$1" "$TMP/setup.out" || fail "the setup report lists '$1': $(cat "$TMP/setup.out")"; }
expect_row 'summary|replica-read|create=0 writable=1 definer=0 volatile=1 outbound=0 member_of=0 leftover=0'
expect_row 'writable|net.http_request_queue|insert, update, delete, truncate'
expect_row 'volatile|net.http_get(text)|volatile, owner supabase_admin'
expect_row 'schema|net|usage'
expect_row 'schema|public|usage'
expect_row "database|$DB|connect, temporary (connect from PUBLIC)"
expect_row 'database|template1|connect (connect from PUBLIC)'
expect_row 'extension|dblink|schema extensions (no usage)'
grep -q '^catalog|large objects|.*lo_create' "$TMP/setup.out" || fail 'the report lists the large-object functions'
grep -q '^catalog|advisory locks|' "$TMP/setup.out" || fail 'the report lists advisory locks'
pass 'the setup report lists the PUBLIC reach: pg_net stand-in (writable, volatile), TEMP, other databases, large objects, advisory locks, dblink without usage'
fn_ok() { super -c "select has_function_privilege('kilo_lease_replica_read', '$1', 'EXECUTE')"; }
[ "$(fn_ok 'public.planted_definer()')" = f ] || fail 'PUBLIC lost EXECUTE on the SECURITY DEFINER function in public'
[ "$(fn_ok 'public.planted_writer()')" = t ] || fail 'a volatile invoker function in public stays executable (it runs with the caller rights)'
[ "$(fn_ok 'public.planted_reader()')" = t ] || fail 'a stable invoker function in public stays executable'
owner -c 'create function public.later_definer() returns int language sql security definer as $$ select 1 $$' >/dev/null
[ "$(fn_ok 'public.later_definer()')" = f ] || fail 'a function postgres creates after setup is not executable by PUBLIC'
pass 'PUBLIC lost EXECUTE on SECURITY DEFINER functions in public, today and for later ones; invoker functions keep it'
super -c 'drop schema net cascade' >/dev/null
report >"$TMP/report.out"
grep -qxF 'summary|replica-read|create=0 writable=0 definer=0 volatile=0 outbound=0 member_of=0 leftover=0' "$TMP/report.out" ||
  fail "without pg_net the summary is all zero: $(cat "$TMP/report.out")"
grep -qxF "volatile|planted_writer()|volatile, owner postgres, sql with the caller's rights" "$TMP/report.out" ||
  fail "the report lists the SQL volatile function without counting it: $(cat "$TMP/report.out")"
pass 'without pg_net the replica template can create nothing, write nothing and run no definer or volatile function'

# replica-read.
if replica_admin -c 'select 1 from public.accounts' >/dev/null 2>&1; then
  fail 'replica admin reads nothing while no lease exists'
fi
if create_replica "lease_rr_ABCDEFGHIJKLMNOPQRST" "$(secret)" "$(expires_in 300)" 2>"$TMP/err"; then
  fail 'a username outside lease_rr_[a-z0-9]{20} is refused'
fi
grep -q 'is not lease_rr_' "$TMP/err" || fail "username refused by check_username: $(cat "$TMP/err")"
[ "$(role_count lease_rr_ABCDEFGHIJKLMNOPQRST)" = 0 ] || fail 'the refused username made no role'
pass 'the creation refuses a username outside lease_rr_[a-z0-9]{20}'
RR1=$(role_name rr)
RR1_PW=$(secret)
create_replica "$RR1" "$RR1_PW" "$(expires_in 300)"
[ "$(super -c "select pg_has_role('$RR1', 'kilo_lease_replica_read', 'member')")" = t ] || fail 'replica lease role is a template member'
[ "$(super -c "select rolconnlimit from pg_roles where rolname = '$RR1'")" = 4 ] || fail 'replica lease role has a connection limit of 4'
pass 'replica-read creation makes a login role in kilo_lease_replica_read with a connection limit of 4'
[ "$(sql "$RR1" "$RR1_PW" -c 'select count(*) from public.accounts')" = 1 ] || fail 'replica lease reads accounts'
[ "$(sql "$RR1" "$RR1_PW" -c 'show default_transaction_read_only' -c 'show statement_timeout' -c 'show idle_in_transaction_session_timeout' | tr '\n' ' ')" = 'on 1min 1min ' ] ||
  fail 'replica lease defaults to read-only transactions and 60-second timeouts'
pass 'the replica lease reads the table, in read-only transactions with 60-second timeouts by default'
if replica_admin -c 'select 1 from public.accounts' >/dev/null 2>&1; then
  fail 'replica admin reads nothing while a lease exists'
fi
pass 'the replica admin holds none of the lease role rights while the lease lives'

# The lease password stays out of the server log with the server logging every statement, every
# duration and the statement of every error: the admin logins' role settings turn all three off for
# their own sessions. A failed creation's error carries no password either. Another login's
# statement in the same log shows that the check sees logged statements.
super -c "alter system set log_statement = 'all'" -c 'alter system set log_min_duration_statement = 0' \
  -c 'select pg_reload_conf()' >/dev/null
sleep 1
RR8=$(role_name rr)
RR8_PW=$(secret)
create_replica "$RR8" "$RR8_PW" "$(expires_in 300)"
[ "$(sql "$RR8" "$RR8_PW" -c 'select 1')" = 1 ] || fail 'the lease made with every statement logged logs in'
FAILED_PW=$(secret)
if create_replica "$RR8" "$FAILED_PW" "$(expires_in 300)" 2>"$TMP/err"; then fail 'a second role of the same name is refused'; fi
grep -q 'was not created' "$TMP/err" || fail "the creation error names the role only: $(cat "$TMP/err")"
if grep -qF "$FAILED_PW" "$TMP/err"; then fail 'the creation error sent to Infisical carries no password'; fi
owner -c "select 'logged-$MARK'" >/dev/null
super -c "alter system reset log_statement" -c 'alter system reset log_min_duration_statement' \
  -c 'select pg_reload_conf()' >/dev/null
docker logs "$NAME" >"$TMP/server.log" 2>&1
grep -qF "logged-$MARK" "$TMP/server.log" || fail 'the server logs another login statement (the check sees logged statements)'
if grep -qF "$RR8_PW" "$TMP/server.log"; then fail 'the lease password is not in the server log'; fi
if grep -qF "$FAILED_PW" "$TMP/server.log"; then fail 'the failed creation password is not in the server log'; fi
pass 'with log_statement = all, log_min_duration_statement = 0 and the default log_min_error_statement, no lease password reaches the server log, nor the error of a failed creation'
revoke_replica "$RR8"
if sql "$RR1" "$RR1_PW" -c 'set default_transaction_read_only = off' \
  -c "insert into public.accounts values (2, 'b@example.invalid')" >/dev/null 2>"$TMP/err"; then
  fail 'replica lease cannot insert with read-only mode off'
fi
grep -q 'permission denied' "$TMP/err" || fail "insert refused by grant: $(cat "$TMP/err")"
if sql "$RR1" "$RR1_PW" -c 'set default_transaction_read_only = off' -c 'create table public.t (x int)' \
  >/dev/null 2>"$TMP/err"; then
  fail 'replica lease cannot create a table'
fi
grep -q 'permission denied' "$TMP/err" || fail "create refused by grant: $(cat "$TMP/err")"
if sql "$RR1" "$RR1_PW" -c 'select public.planted_definer()' >/dev/null 2>&1; then
  fail 'replica lease cannot run the SECURITY DEFINER function'
fi
pass 'with read-only mode off, INSERT, CREATE TABLE and the SECURITY DEFINER function are refused by grant'

# The role-creating logins cannot reach the other template or end another role's session.
if replica_admin -c 'create role kilo_escalate login in role kilo_lease_migration' >/dev/null 2>&1; then
  fail 'replica admin cannot create a migration role'
fi
if replica_admin -c 'create role kilo_escalate login superuser' >/dev/null 2>&1; then
  fail 'replica admin cannot create a superuser'
fi
pass 'the replica admin cannot create a migration role or a superuser'
open_session app_pool "$APP_PW" "$TMP/app.log"
APP_SESSION=$SESSION
wait_for_session app_pool
APP_PID=$(super -c "select pid from pg_stat_activity where usename = 'app_pool'")
if replica_admin -c "select pg_terminate_backend($APP_PID)" >/dev/null 2>"$TMP/err"; then
  fail 'the replica admin cannot end an application session'
fi
grep -q 'permission denied to terminate' "$TMP/err" || fail "terminate refused: $(cat "$TMP/err")"
[ "$(replica_admin -c "select kilo_lease.end_sessions('app_pool')")" = 0 ] || fail 'end_sessions ends no application session'
[ "$(migration_admin -c "select kilo_lease.end_sessions('app_pool')")" = 0 ] || fail 'end_sessions ends no application session'
open_session "$RR1" "$RR1_PW" "$TMP/rr1.log"
RR1_SESSION=$SESSION
wait_for_session "$RR1"
[ "$(migration_admin -c "select kilo_lease.end_sessions('$RR1')")" = 0 ] || fail 'the migration admin ends no replica session'
[ "$(sessions_of app_pool)" = 1 ] && [ "$(sessions_of "$RR1")" = 1 ] || fail 'both sessions are still open'
if sql app_pool "$APP_PW" -c "select kilo_lease.end_sessions('$RR1')" >/dev/null 2>&1; then
  fail 'only the admin logins can call end_sessions'
fi
pass 'neither admin can end an application session, and the migration admin cannot end a replica session'

# Renew moves VALID UNTIL.
infisical kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$HERE/renew.sql" "$RR1" unused "$(expires_in 3600)"
[ "$(super -c "select rolvaliduntil > now() + interval '50 minutes' from pg_roles where rolname = '$RR1'")" = t ] || fail 'renew moves VALID UNTIL'
pass 'renewal moves VALID UNTIL'

# Expiry: VALID UNTIL refuses new logins, and an open session lives on (design decision Q63) until a
# revocation on this node; any revocation of the template sweeps expired lease roles' sessions.
RR2=$(role_name rr)
RR2_PW=$(secret)
create_replica "$RR2" "$RR2_PW" "$(expires_in 10)"
open_session "$RR2" "$RR2_PW" "$TMP/rr2.log"
RR2_SESSION=$SESSION
wait_for_session "$RR2"
sleep 12
if can_login "$RR2" "$RR2_PW"; then fail 'an expired lease cannot log in'; fi
pass 'after VALID UNTIL a new login is refused'
[ "$(sessions_of "$RR2")" -ge 1 ] || fail 'the open session outlives VALID UNTIL'
pass 'a session opened before VALID UNTIL is still open after it'

revoke_replica "$RR1"
if wait "$RR1_SESSION"; then fail 'the open session is ended'; fi
grep -q 'terminating connection due to administrator command' "$TMP/rr1.log" || fail "session ended by revocation: $(cat "$TMP/rr1.log")"
[ "$(role_count "$RR1")" = 0 ] || fail 'revocation drops the role'
pass 'revocation ends the open session and drops the role'
if wait "$RR2_SESSION"; then fail 'the expired lease session is ended'; fi
[ "$(sessions_of "$RR2")" = 0 ] || fail 'no session of the expired lease remains'
pass 'the revocation of another lease also ended the expired lease session'
revoke_replica "$RR2"
revoke_replica "$RR2"
[ "$(role_count "$RR2")" = 0 ] || fail 'revocation drops the expired role'
pass 'revocation is idempotent'
[ "$(sessions_of app_pool)" = 1 ] || fail 'the application session survived every revocation'
kill "$APP_SESSION" 2>/dev/null || true
wait "$APP_SESSION" 2>/dev/null || true

# Revoke while a client keeps reconnecting: no session of the lease survives it, and none of a
# dropped role is left. The block commits before the drop, so every login that got in shows up
# before the drop and is ended. In the ci-migration round such a session would keep acting as
# `postgres`.
reconnect_through_revoke() { # kind role password
  (
    for _ in $(seq 1 40); do
      PGPASSWORD=$3 psql -h 127.0.0.1 -p "$PORT" -U "$2" -d "$DB" -qtAc 'select pg_sleep(30)' >/dev/null 2>&1 &
      sleep 0.05
    done
    wait
  ) &
  LOOP=$!
  sleep 1
  "revoke_$1" "$2"
  sleep 2.5
  [ "$(role_count "$2")" = 0 ] || fail 'the reconnecting lease role is dropped'
  [ "$(orphans)" = 0 ] || fail "no session of a dropped role is left: $(orphans)"
  kill "$LOOP" 2>/dev/null || true
  wait "$LOOP" 2>/dev/null || true
}
for _ in 1 2 3; do
  RR3=$(role_name rr)
  RR3_PW=$(secret)
  create_replica "$RR3" "$RR3_PW" "$(expires_in 300)"
  reconnect_through_revoke replica "$RR3" "$RR3_PW"
done
CM3=$(role_name cm)
CM3_PW=$(secret)
create_migration "$CM3" "$CM3_PW" "$(expires_in 300)"
reconnect_through_revoke migration "$CM3" "$CM3_PW"
pass 'a client reconnecting through a revocation keeps no session and leaves none of a dropped role (3 replica rounds and 1 ci-migration round of 40 logins)'

# A revocation statement that skips the committed block (one transaction, the commit gap) is refused
# and changes nothing.
RR10=$(role_name rr)
RR10_PW=$(secret)
create_replica "$RR10" "$RR10_PW" "$(expires_in 300)"
echo "SELECT kilo_lease.revoke_lease('{{username}}')" >"$TMP/one-transaction.revoke.sql"
if infisical kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$TMP/one-transaction.revoke.sql" "$RR10" unused unused 2>"$TMP/err"; then
  fail 'a revocation without the committed block is refused'
fi
grep -q 'still has its login' "$TMP/err" || fail "refused for its login: $(cat "$TMP/err")"
can_login "$RR10" "$RR10_PW" || fail 'the refused revocation changed nothing'
revoke_replica "$RR10"
pass 'a revocation statement without the committed block is refused'

# A large object and a temporary table of an open session: revocation drops both with the role.
RR7=$(role_name rr)
RR7_PW=$(secret)
create_replica "$RR7" "$RR7_PW" "$(expires_in 300)"
open_session "$RR7" "$RR7_PW" "$TMP/rr7.log" 'begin read write; select lo_create(0); create temp table scratch (x int); commit'
RR7_SESSION=$SESSION
wait_for_session "$RR7"
sleep 0.5
[ "$(super -c "select count(*) from pg_largeobject_metadata where lomowner = '$RR7'::regrole")" = 1 ] || fail 'the lease made a large object'
revoke_replica "$RR7"
wait "$RR7_SESSION" || true
[ "$(role_count "$RR7")" = 0 ] || fail 'revocation drops a role that owned a large object'
[ "$(super -c 'select count(*) from pg_largeobject_metadata')" = 0 ] || fail 'the large object is gone'
pass 'revocation drops the large object and the temporary table a lease session made'

# A role revocation cannot drop (an object in another database) stays without login.
RR6=$(role_name rr)
RR6_PW=$(secret)
create_replica "$RR6" "$RR6_PW" "$(expires_in 300)"
sql_in template1 "$RR6" "$RR6_PW" -c 'set default_transaction_read_only = off' -c 'select lo_create(0)' >/dev/null
revoke_replica "$RR6"
[ "$(role_count "$RR6")" = 1 ] || fail 'a role owning an object elsewhere is kept'
if can_login "$RR6" "$RR6_PW"; then fail 'the kept role cannot log in'; fi
report >"$TMP/report.out"
grep -qxF "leftover|$RR6|revoked lease role kept without login; drop it by hand" "$TMP/report.out" || fail "the report lists the kept role: $(cat "$TMP/report.out")"
sql_in template1 kilo_lease_replica_admin "$REPLICA_ADMIN_PW" \
  -c "grant \"$RR6\" to kilo_lease_replica_admin with inherit true, set false" -c "drop owned by \"$RR6\"" >/dev/null
revoke_replica "$RR6"
[ "$(role_count "$RR6")" = 0 ] || fail 'the kept role drops once its object elsewhere is gone'
pass 'a role with a large object in template1 is kept without login and listed, then dropped by hand'

# ci-migration: owner-level DDL as postgres, nothing owned by the lease role.
CM1=$(role_name cm)
CM1_PW=$(secret)
create_migration "$CM1" "$CM1_PW" "$(expires_in 300)"
[ "$(sql "$CM1" "$CM1_PW" -c "select current_user || '/' || session_user")" = "postgres/$CM1" ] || fail 'migration lease runs as postgres'
pass 'a ci-migration session runs as postgres and is logged in as its lease role'
if sql "$CM1" "$CM1_PW" -c 'create or replace function kilo_lease.create_lease(username text, password text, valid_until timestamptz) returns void language sql as $$ select $$' >/dev/null 2>"$TMP/err"; then
  fail 'a ci-migration lease cannot replace kilo_lease.create_lease'
fi
grep -qE 'must be owner|permission denied for schema kilo_lease' "$TMP/err" || fail "replace refused for ownership: $(cat "$TMP/err")"
pass 'a ci-migration lease cannot replace kilo_lease.create_lease'
sql "$CM1" "$CM1_PW" -c 'create extension if not exists pgcrypto' -c 'create table public.migrated (id int)' \
  -c 'alter table public.accounts add column note text' -c 'create index on public.accounts (email)' >/dev/null
[ "$(super -c "select tableowner from pg_tables where tablename = 'migrated'")" = postgres ] || fail 'the new table belongs to postgres'
pass 'CREATE EXTENSION, CREATE TABLE, ALTER TABLE and CREATE INDEX run, and postgres owns the result'
if sql "$CM1" "$CM1_PW" -c 'set role none' -c 'create table public.own (x int)' >/dev/null 2>"$TMP/err"; then
  fail 'without SET ROLE postgres the lease role creates nothing'
fi
grep -q 'permission denied for schema public' "$TMP/err" || fail "create refused: $(cat "$TMP/err")"
pass 'with SET ROLE NONE the lease role holds none of postgres rights (INHERIT FALSE)'
if migration_admin -c 'set role postgres' >/dev/null 2>&1; then fail 'the migration admin cannot become postgres'; fi
if migration_admin -c 'select 1 from public.accounts' >/dev/null 2>&1; then fail 'migration admin cannot read accounts'; fi
pass 'during a lease the migration admin can neither become postgres nor read accounts'
RR5=$(role_name rr)
RR5_PW=$(secret)
create_replica "$RR5" "$RR5_PW" "$(expires_in 300)"
[ "$(sql "$RR5" "$RR5_PW" -c 'select count(*) from public.migrated')" = 0 ] || fail 'replica lease reads a table created after setup'
pass 'a replica lease reads a table a migration created after setup (default privileges)'
revoke_replica "$RR5"

open_session "$CM1" "$CM1_PW" "$TMP/cm1.log" 'set role none; select lo_create(0)'
CM1_SESSION=$SESSION
wait_for_session "$CM1"
revoke_migration "$CM1"
if wait "$CM1_SESSION"; then fail 'the open migration session is ended'; fi
[ "$(role_count "$CM1")" = 0 ] || fail 'migration revocation drops the role'
[ "$(super -c 'select count(*) from pg_largeobject_metadata')" = 0 ] || fail 'the large object of the migration lease is gone'
pass 'migration revocation ends the open session, drops what the lease role owned, and drops the role'

# A lease acting as postgres can grant its own role a right; the drop then fails, and the role stays
# without login (design decision Q64: such a lease can leave anything behind).
CM2=$(role_name cm)
CM2_PW=$(secret)
create_migration "$CM2" "$CM2_PW" "$(expires_in 300)"
sql "$CM2" "$CM2_PW" -c "grant select on public.accounts to \"$CM2\"" >/dev/null
open_session "$CM2" "$CM2_PW" "$TMP/cm2.log"
CM2_SESSION=$SESSION
wait_for_session "$CM2"
revoke_migration "$CM2"
if wait "$CM2_SESSION"; then fail 'the session of the kept role is ended'; fi
[ "$(role_count "$CM2")" = 1 ] || fail 'a role with a right postgres granted is kept'
if can_login "$CM2" "$CM2_PW"; then fail 'the kept migration role cannot log in'; fi
owner -c "revoke select on public.accounts from \"$CM2\"" >/dev/null
revoke_migration "$CM2"
[ "$(role_count "$CM2")" = 0 ] || fail 'the kept role drops once the right is revoked'
pass 'a migration role holding a right postgres granted is kept without login and no session, then dropped by hand'

# Why revocation ends sessions before DROP ROLE: the drop succeeds with a session open, the session
# lives on, and pg_stat_activity no longer names its user. end_sessions sweeps such sessions.
RR4=$(role_name rr)
RR4_PW=$(secret)
create_replica "$RR4" "$RR4_PW" "$(expires_in 300)"
open_session "$RR4" "$RR4_PW" "$TMP/rr4.log"
RR4_SESSION=$SESSION
wait_for_session "$RR4"
PID=$(super -c "select pid from pg_stat_activity where usename = '$RR4'")
super -c "drop role \"$RR4\"" >/dev/null
[ "$(super -c "select count(*) from pg_stat_activity where pid = $PID and usename is null")" = 1 ] || fail 'the dropped role keeps an unnamed session'
pass 'DROP ROLE alone leaves the session open and unnamed'
revoke_replica "$(role_name rr)"
if wait "$RR4_SESSION"; then fail 'the unnamed session is ended'; fi
[ "$(orphans)" = 0 ] || fail 'no unnamed session remains'
pass 'the next revocation ends a session of a lease role that was dropped'

# A session of a role that was never a lease is never ended, also after its role is dropped.
super -c "create role app_dropped login password '$APP_PW'" >/dev/null
open_session app_dropped "$APP_PW" "$TMP/dropped.log"
DROPPED_SESSION=$SESSION
wait_for_session app_dropped
super -c 'drop role app_dropped' >/dev/null
[ "$(orphans)" = 1 ] || fail 'the dropped application role keeps its session'
revoke_replica "$(role_name rr)"
revoke_migration "$(role_name cm)"
sleep 0.5
[ "$(orphans)" = 1 ] || fail 'no revocation ends the session of a dropped role that was never a lease'
kill "$DROPPED_SESSION" 2>/dev/null || true
wait "$DROPPED_SESSION" 2>/dev/null || true
super -c "select pg_terminate_backend(pid) from pg_stat_activity where backend_type = 'client backend' and usename is null" >/dev/null
pass 'a revocation leaves the session of a dropped role that was never a lease alone'

# Replica sessions (design decision Q63). The standby got every role, the kilo_lease objects and
# their rows through replication. A revocation or an expiry runs on the primary and ends the
# lease's sessions there only; kilo_lease.sweep_sessions(), run on the replica as
# kilo_lease_sweeper (what the lease object does once a minute through Hyperdrive), ends them on
# the replica.
caught_up
[ "$(replica_super -c 'select pg_is_in_recovery()')" = t ] || fail 'the replica is a hot standby'
[ "$(replica_super -c "select pg_get_userbyid(proowner) from pg_proc where proname = 'sweep_sessions'")" = kilo_lease_owner ] ||
  fail 'the replica has sweep_sessions, owned by kilo_lease_owner'
if replica_super -c 'create table public.on_replica (x int)' >/dev/null 2>&1; then fail 'the replica refuses writes'; fi
pass 'the replica is a read-only hot standby with sweep_sessions owned by kilo_lease_owner'

# Sessions no sweep may end: an application login, `postgres`, the superuser, a live lease of
# each template, the sweeper's own other session, and a role that was dropped but never a lease.
LIVE=$(role_name rr)
LIVE_PW=$(secret)
create_replica "$LIVE" "$LIVE_PW" "$(expires_in 600)"
LIVE_CM=$(role_name cm)
LIVE_CM_PW=$(secret)
create_migration "$LIVE_CM" "$LIVE_CM_PW" "$(expires_in 600)"
super -c "create role app_gone login password '$APP_PW'" >/dev/null
caught_up
KEEP=()
for login in "app_pool $APP_PW" "postgres $OWNER_PW" "supabase_admin $SUPER_PW" "$LIVE $LIVE_PW" \
  "$LIVE_CM $LIVE_CM_PW" "kilo_lease_sweeper $SWEEPER_PW" "app_gone $APP_PW"; do
  # shellcheck disable=SC2086 # login and password, split on purpose
  replica_session $login
  KEEP+=("$RPID")
done
super -c 'drop role app_gone' >/dev/null
caught_up
keep_alive() { # what
  for pid in "${KEEP[@]}"; do replica_alive "$pid" || fail "$1: replica session $pid is still open"; done
}
keep_alive 'before any sweep'

# Revocation: the primary drops the role; its idle replica session stays until the sweep.
RR20=$(role_name rr)
RR20_PW=$(secret)
create_replica "$RR20" "$RR20_PW" "$(expires_in 600)"
caught_up
replica_session "$RR20" "$RR20_PW"
R20=$RPID
revoke_replica "$RR20"
caught_up
[ "$(replica_super -c "select count(*) from pg_roles where rolname = '$RR20'")" = 0 ] || fail 'the drop reached the replica'
sleep 1
replica_alive "$R20" || fail 'the revocation on the primary leaves the replica session open (design decision Q63)'
pass 'KNOWN (design decision Q63): after the revocation dropped the role on the primary, its idle replica session is still open'
[ "$(sweep)" = 1 ] || fail 'the sweep ends the revoked lease session on the replica'
replica_ended "$R20"
pass 'the sweep on the replica ends the session of the revoked lease'

# Expiry whose revocation did not run (or failed): the role still exists, past VALID UNTIL.
RR21=$(role_name rr)
RR21_PW=$(secret)
create_replica "$RR21" "$RR21_PW" "$(expires_in 6)"
caught_up
replica_session "$RR21" "$RR21_PW"
R21=$RPID
sleep 7
[ "$(role_count "$RR21")" = 1 ] || fail 'the expired role still exists'
replica_alive "$R21" || fail 'a replica session outlives VALID UNTIL'
[ "$(sweep)" = 1 ] || fail 'the sweep ends the session of a lease past VALID UNTIL'
replica_ended "$R21"
revoke_replica "$RR21"
pass 'the sweep ends the replica session of an expired lease whose revocation did not run'

# A revocation whose first transaction committed (NOLOGIN) and whose second did not.
RR22=$(role_name rr)
RR22_PW=$(secret)
create_replica "$RR22" "$RR22_PW" "$(expires_in 600)"
caught_up
replica_session "$RR22" "$RR22_PW"
R22=$RPID
replica_admin -c "select kilo_lease.block_lease('$RR22')" >/dev/null
caught_up
replica_alive "$R22" || fail 'the blocked lease keeps its replica session until the sweep'
[ "$(sweep)" = 1 ] || fail 'the sweep ends the session of a blocked lease'
replica_ended "$R22"
revoke_replica "$RR22"
pass 'the sweep ends the replica session of a lease blocked by a half-done revocation'

# A ci-migration lease on the replica (its session runs as `postgres`) after its revocation.
CM20=$(role_name cm)
CM20_PW=$(secret)
create_migration "$CM20" "$CM20_PW" "$(expires_in 600)"
caught_up
replica_session "$CM20" "$CM20_PW"
C20=$RPID
revoke_migration "$CM20"
caught_up
[ "$(sweep)" = 1 ] || fail 'the sweep ends the revoked ci-migration session on the replica'
replica_ended "$C20"
pass 'the sweep ends the replica session of a revoked ci-migration lease'

# The row of a dropped lease role outlives later revocations of its template (setup.sql's
# end_sessions forgot it at the next one, as the primary had no session of it), so the replica's
# sweep still knows it was a lease; 7 days after the role went, the row goes.
RR23=$(role_name rr)
RR23_PW=$(secret)
create_replica "$RR23" "$RR23_PW" "$(expires_in 600)"
OID23=$(super -c "select oid from pg_roles where rolname = '$RR23'")
caught_up
replica_session "$RR23" "$RR23_PW"
R23=$RPID
revoke_replica "$RR23"
revoke_replica "$(role_name rr)"
caught_up
[ "$(super -c "select count(*) from kilo_lease.lease_role where role = $OID23 and gone_since is not null")" = 1 ] ||
  fail 'a later revocation keeps the dropped lease role row and marks when it went'
[ "$(sweep)" = 1 ] || fail 'the sweep ends the session of a lease dropped before a later revocation'
replica_ended "$R23"
pass 'after a later revocation of the template, the replica sweep still ends the session of the dropped lease'
super -c "update kilo_lease.lease_role set gone_since = now() - interval '8 days' where role = $OID23" >/dev/null
revoke_replica "$(role_name rr)"
[ "$(super -c "select count(*) from kilo_lease.lease_role where role = $OID23")" = 0 ] ||
  fail 'a revocation forgets the row of a role gone over 7 days'
pass 'a revocation forgets the row of a lease role gone over 7 days, so the table stays small'

caught_up
[ "$(sweep)" = 0 ] || fail 'a sweep with no ended lease session ends nothing'
keep_alive 'after every sweep'
pass 'no sweep ended an application, postgres, superuser, live-lease, sweeper or dropped non-lease session'

# The sweeper login can do nothing else, on either node.
if sweeper -c "select pg_terminate_backend(${KEEP[0]})" >/dev/null 2>"$TMP/err"; then
  fail 'the sweeper cannot end an application session directly'
fi
grep -q 'permission denied to terminate' "$TMP/err" || fail "terminate refused: $(cat "$TMP/err")"
if sweeper -c "select kilo_lease.end_sessions('app_pool')" >/dev/null 2>&1; then fail 'the sweeper cannot call end_sessions'; fi
if sweeper -c 'select 1 from public.accounts' >/dev/null 2>&1; then fail 'the sweeper reads no application table'; fi
if sql app_pool "$APP_PW" -c 'select kilo_lease.sweep_sessions()' >/dev/null 2>&1; then
  fail 'only the sweeper (and the owner) can call sweep_sessions'
fi
[ "$(sql kilo_lease_sweeper "$SWEEPER_PW" -c 'select kilo_lease.sweep_sessions()')" = 0 ] ||
  fail 'the sweep on the primary ends nothing while no ended lease has a session there'
keep_alive 'after the sweeper tried to end one directly'
pass 'the sweeper login can end no session directly, call no other kilo_lease function, read no table; on the primary its sweep ends nothing live'
revoke_replica "$LIVE"
revoke_migration "$LIVE_CM"
replica_super -c "select pg_terminate_backend(pid) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()" >/dev/null

echo 'ALL PASS'
