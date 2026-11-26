#!/usr/bin/env bash
# Local check of the lease SQL (README, "Database leases") against a throwaway PostgreSQL in
# Docker; never against a real database. It mirrors Supabase's roles: the bootstrap superuser is
# `supabase_admin`; `postgres` is a non-superuser CREATEROLE login that owns the database and the
# `public` schema and is a member of pg_signal_backend, pg_monitor and pg_read_all_data; a schema
# `net` stands in for pg_net's PUBLIC grants. It runs setup.sql as `postgres` and
# setup-ci-migration.sql as the superuser, then each statement file the way Infisical runs it: the
# template variables filled in, the text split on ';', and every part in one transaction, as the
# dynamic secret's own login. Every password is generated here. Exits 1 on the first failure.
#
#   PG_IMAGE=postgres:16 services/sts/sql/leases/check.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${PG_IMAGE:-postgres:16}
PORT=${PG_PORT:-55432}
NAME=sts-lease-sql-check-$PORT
DB=postgres
TMP=$(mktemp -d)

secret() { openssl rand -hex 24; }
role_name() { echo "lease_$1_$(openssl rand -hex 10)"; }
SUPER_PW=$(secret)
OWNER_PW=$(secret)
APP_PW=$(secret)
REPLICA_ADMIN_PW=$(secret)
MIGRATION_ADMIN_PW=$(secret)

pass() { echo "PASS $*"; }
fail() {
  echo "FAIL $*"
  exit 1
}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD="$SUPER_PW" -e POSTGRES_DB="$DB" \
  "$IMAGE" >/dev/null
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  if PGPASSWORD=$SUPER_PW psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d "$DB" -qtAc 'select 1' >/dev/null 2>&1; then
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

echo "PostgreSQL $(super -c 'show server_version')"

# Supabase's shape: `postgres` owns the database, the schema and the application tables, and an
# application pool logs in as its own role.
super -c "create role postgres login createrole password '$OWNER_PW'" \
  -c "alter database $DB owner to postgres" -c 'alter schema public owner to postgres' \
  -c 'grant pg_signal_backend, pg_monitor, pg_read_all_data to postgres' \
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
  -c 'create function net.http_get(url text) returns bigint language sql volatile as $$ select 1::bigint $$' \
  -c 'create schema extensions' -c 'create extension dblink schema extensions' >/dev/null

if owner -c 'create role kilo_probe nologin' -c 'grant postgres to kilo_probe' >/dev/null 2>&1; then
  echo 'INFO the non-superuser owner can grant its own membership on this version'
else
  echo 'INFO the non-superuser owner cannot grant its own membership on this version; setup-ci-migration.sql needs a superuser'
fi
super -c 'drop role if exists kilo_probe' >/dev/null

owner -v replica_admin_password="$REPLICA_ADMIN_PW" -f "$HERE/setup.sql" >"$TMP/setup.out"
pass 'setup.sql ran as postgres'

# Known limit (README Risks, design decision Q64): `postgres` administers every role it created,
# so it can reset the replica admin's password. An owner role in between would not help: ADMIN
# follows memberships, and only a superuser can remove the creator's implicit grant.
owner -c "alter role kilo_lease_replica_admin password '$REPLICA_ADMIN_PW'" >/dev/null ||
  fail 'postgres can reset the replica admin password after setup.sql (if not, update the README and Q64)'
pass 'KNOWN after setup.sql, postgres can reset the replica admin password'
if owner -v migration_admin_password="$MIGRATION_ADMIN_PW" -f "$HERE/setup-ci-migration.sql" >/dev/null 2>"$TMP/err"; then
  fail 'setup-ci-migration.sql needs a superuser'
fi
super -v migration_admin_password="$MIGRATION_ADMIN_PW" -f "$HERE/setup-ci-migration.sql" >/dev/null
pass 'setup-ci-migration.sql fails as postgres and runs as the superuser'
for admin in kilo_lease_replica_admin kilo_lease_migration_admin; do
  if owner -c "alter role $admin password 'reset-by-postgres'" >/dev/null 2>&1; then
    fail "after setup-ci-migration.sql, postgres cannot reset the $admin password"
  fi
done
pass 'after setup-ci-migration.sql, postgres (and so a ci-migration lease) cannot reset either admin password'

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
[ "$(fn_ok 'public.planted_writer()')" = f ] || fail 'PUBLIC lost EXECUTE on the volatile function in public'
[ "$(fn_ok 'public.planted_reader()')" = t ] || fail 'a stable invoker function in public stays executable'
owner -c 'create function public.later_definer() returns int language sql security definer as $$ select 1 $$' >/dev/null
[ "$(fn_ok 'public.later_definer()')" = f ] || fail 'a function postgres creates after setup is not executable by PUBLIC'
pass 'PUBLIC lost EXECUTE on SECURITY DEFINER and volatile functions in public, today and for later ones'
super -c 'drop schema net cascade' >/dev/null
report >"$TMP/report.out"
grep -qxF 'summary|replica-read|create=0 writable=0 definer=0 volatile=0 outbound=0 member_of=0 leftover=0' "$TMP/report.out" ||
  fail "without pg_net the summary is all zero: $(cat "$TMP/report.out")"
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

# Revoke while a client keeps reconnecting: no session of the lease survives it. A login that lands
# between the last termination and the commit keeps a session of a dropped role, which has no
# rights left; the next revocation ends it.
for round in 1 2 3; do
  RR3=$(role_name rr)
  RR3_PW=$(secret)
  create_replica "$RR3" "$RR3_PW" "$(expires_in 300)"
  (
    for _ in $(seq 1 40); do
      PGPASSWORD=$RR3_PW psql -h 127.0.0.1 -p "$PORT" -U "$RR3" -d "$DB" -qtAc 'select pg_sleep(30)' >/dev/null 2>&1 &
      sleep 0.05
    done
    wait
  ) &
  LOOP=$!
  sleep 1
  revoke_replica "$RR3"
  sleep 2.5
  [ "$(role_count "$RR3")" = 0 ] || fail 'the reconnecting lease role is dropped'
  left=$(orphans)
  if [ "$left" != 0 ]; then
    echo "INFO round $round: $left login(s) landed during the revocation's commit; the next revocation ends them"
    revoke_replica "$(role_name rr)"
    sleep 0.5
    [ "$(orphans)" = 0 ] || fail 'the next revocation ends a session of a dropped lease role'
  fi
  kill "$LOOP" 2>/dev/null || true
  wait "$LOOP" 2>/dev/null || true
done
pass 'a client reconnecting through a revocation keeps no session (3 rounds of 40 logins)'

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
sql_in template1 kilo_lease_replica_admin "$REPLICA_ADMIN_PW" -c "drop owned by \"$RR6\"" >/dev/null
revoke_replica "$RR6"
[ "$(role_count "$RR6")" = 0 ] || fail 'the kept role drops once its object elsewhere is gone'
pass 'a role with a large object in template1 is kept without login and listed, then dropped by hand'

# ci-migration: owner-level DDL as postgres, nothing owned by the lease role.
CM1=$(role_name cm)
CM1_PW=$(secret)
create_migration "$CM1" "$CM1_PW" "$(expires_in 300)"
[ "$(sql "$CM1" "$CM1_PW" -c "select current_user || '/' || session_user")" = "postgres/$CM1" ] || fail 'migration lease runs as postgres'
pass 'a ci-migration session runs as postgres and is logged in as its lease role'
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
pass 'the next revocation ends a session whose role was dropped'

echo 'ALL PASS'
