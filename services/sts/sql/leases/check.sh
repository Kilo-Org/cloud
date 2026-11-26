#!/usr/bin/env bash
# Local check of the lease SQL (README, "Database leases") against a throwaway PostgreSQL in
# Docker; never against a real database. It mirrors Supabase's roles: the bootstrap superuser is
# `supabase_admin`, and `postgres` is a non-superuser CREATEROLE login that owns the `public`
# schema. It runs setup.sql, then each statement file the way Infisical runs it: the template
# variables filled in, the text split on ';', and every part in one transaction, as the dynamic
# secret's own login. Every password is generated here. Exits 1 on the first failure.
#
#   PG_IMAGE=postgres:16 services/sts/sql/leases/check.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${PG_IMAGE:-postgres:16}
PORT=${PG_PORT:-55432}
NAME=sts-lease-sql-check
DB=postgres

secret() { openssl rand -hex 24; }
role_name() { echo "lease_$1_$(openssl rand -hex 10)"; }
SUPER_PW=$(secret)
OWNER_PW=$(secret)
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
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  if PGPASSWORD=$SUPER_PW psql -h 127.0.0.1 -p "$PORT" -U supabase_admin -d "$DB" -qtAc 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# psql as one login over TCP with a password, so VALID UNTIL applies.
sql() { # login password sql...
  local login=$1 password=$2
  shift 2
  PGPASSWORD=$password psql -h 127.0.0.1 -p "$PORT" -U "$login" -d "$DB" -v ON_ERROR_STOP=1 -qtA "$@"
}
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
revoke_as() { # admin-login admin-password username
  infisical "$1" "$2" "$HERE/revoke.sql" "$3" unused unused
}
expires_in() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%S.000Z; }
role_count() { super -c "select count(*) from pg_roles where rolname = '$1'"; }
# Starts a session of `login` that sleeps, in this shell so `wait "$SESSION"` can reap it. Its
# output goes to the log file.
open_session() { # login password log
  PGPASSWORD=$2 psql -h 127.0.0.1 -p "$PORT" -U "$1" -d "$DB" -qtAc 'select pg_sleep(60)' >"$3" 2>&1 &
  SESSION=$!
}
wait_for_session() { # login
  for _ in $(seq 1 50); do
    [ "$(super -c "select count(*) from pg_stat_activity where usename = '$1'")" -ge 1 ] && return 0
    sleep 0.2
  done
  fail "a session of $1 opened"
}

echo "PostgreSQL $(super -c 'show server_version')"

# Supabase's shape: `postgres` owns the schema and the application tables.
super -c "create role postgres login createrole password '$OWNER_PW'" \
  -c 'alter schema public owner to postgres' -c "grant create on database $DB to postgres" >/dev/null
owner -c 'create table public.accounts (id int primary key, email text)' \
  -c "insert into public.accounts values (1, 'a@example.invalid')" >/dev/null

if owner -c 'create role kilo_probe nologin' -c 'grant postgres to kilo_probe' >/dev/null 2>&1; then
  echo 'INFO the non-superuser owner can grant its own membership on this version'
else
  echo 'INFO the non-superuser owner cannot grant its own membership on this version; setup.sql needs a role with ADMIN on postgres'
fi
super -c 'drop role if exists kilo_probe' >/dev/null

super -v replica_admin_password="$REPLICA_ADMIN_PW" -v migration_admin_password="$MIGRATION_ADMIN_PW" \
  -f "$HERE/setup.sql" >"/tmp/$NAME-setup.out"
[ "$(tail -n 1 "/tmp/$NAME-setup.out")" = 'f|0' ] || fail "setup check prints f|0: $(tail -n 1 "/tmp/$NAME-setup.out")"
pass 'setup.sql ran; the replica template can create nothing and write to no table'

# replica-read: create, read, read-only by grant.
RR1=$(role_name rr)
RR1_PW=$(secret)
create_replica "$RR1" "$RR1_PW" "$(expires_in 300)"
[ "$(super -c "select pg_has_role('$RR1', 'kilo_lease_replica_read', 'member')")" = t ] || fail 'replica lease role is a template member'
pass 'replica-read creation makes a login role in kilo_lease_replica_read'
[ "$(sql "$RR1" "$RR1_PW" -c 'select count(*) from public.accounts')" = 1 ] || fail 'replica lease reads accounts'
[ "$(sql "$RR1" "$RR1_PW" -c 'show default_transaction_read_only')" = on ] || fail 'replica lease defaults to read-only transactions'
pass 'the replica lease reads the table, in read-only transactions by default'
if sql "$RR1" "$RR1_PW" -c 'set default_transaction_read_only = off' \
  -c "insert into public.accounts values (2, 'b@example.invalid')" >/dev/null 2>"/tmp/$NAME.err"; then
  fail 'replica lease cannot insert with read-only mode off'
fi
grep -q 'permission denied' "/tmp/$NAME.err" || fail "insert refused by grant: $(cat "/tmp/$NAME.err")"
if sql "$RR1" "$RR1_PW" -c 'set default_transaction_read_only = off' -c 'create table public.t (x int)' \
  >/dev/null 2>"/tmp/$NAME.err"; then
  fail 'replica lease cannot create a table'
fi
grep -q 'permission denied' "/tmp/$NAME.err" || fail "create refused by grant: $(cat "/tmp/$NAME.err")"
pass 'with read-only mode turned off, INSERT and CREATE TABLE are still refused by grant'

# The role-creating logins hold no template right and cannot reach the other template.
if sql kilo_lease_replica_admin "$REPLICA_ADMIN_PW" -c 'select 1 from public.accounts' >/dev/null 2>&1; then
  fail 'replica admin cannot read accounts'
fi
if sql kilo_lease_replica_admin "$REPLICA_ADMIN_PW" -c 'create role kilo_escalate login in role kilo_lease_migration' >/dev/null 2>&1; then
  fail 'replica admin cannot create a migration role'
fi
if sql kilo_lease_replica_admin "$REPLICA_ADMIN_PW" -c 'create role kilo_escalate login superuser' >/dev/null 2>&1; then
  fail 'replica admin cannot create a superuser'
fi
pass 'the replica admin reads nothing and cannot create a migration role or a superuser'

# Renew moves VALID UNTIL.
infisical kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$HERE/renew.sql" "$RR1" unused "$(expires_in 3600)"
[ "$(super -c "select rolvaliduntil > now() + interval '50 minutes' from pg_roles where rolname = '$RR1'")" = t ] || fail 'renew moves VALID UNTIL'
pass 'renewal moves VALID UNTIL'

# Expiry: VALID UNTIL refuses new logins, and an open session lives on (design decision Q63).
RR2=$(role_name rr)
RR2_PW=$(secret)
create_replica "$RR2" "$RR2_PW" "$(expires_in 10)"
open_session "$RR2" "$RR2_PW" "/tmp/$NAME-rr2.log"
wait_for_session "$RR2"
sleep 12
if sql "$RR2" "$RR2_PW" -c 'select 1' >/dev/null 2>&1; then fail 'an expired lease cannot log in'; fi
pass 'after VALID UNTIL a new login is refused'
[ "$(super -c "select count(*) from pg_stat_activity where usename = '$RR2'")" -ge 1 ] || fail 'the open session outlives VALID UNTIL'
pass 'a session opened before VALID UNTIL is still open after it'

# Revocation ends the open session and drops the role.
revoke_as kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$RR2"
if wait "$SESSION"; then fail 'the open session is ended'; fi
grep -q 'terminating connection due to administrator command' "/tmp/$NAME-rr2.log" || fail "session ended by revocation: $(cat "/tmp/$NAME-rr2.log")"
[ "$(role_count "$RR2")" = 0 ] || fail 'revocation drops the role'
pass 'revocation ends the open session and drops the role'
revoke_as kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$RR2"
revoke_as kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$RR1"
[ "$(role_count "$RR1")" = 0 ] || fail 'revocation drops the renewed role'
pass 'revocation is idempotent, and drops a role with no session'

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
RR3=$(role_name rr)
RR3_PW=$(secret)
create_replica "$RR3" "$RR3_PW" "$(expires_in 300)"
[ "$(sql "$RR3" "$RR3_PW" -c 'select count(*) from public.migrated')" = 0 ] || fail 'replica lease reads a table created after setup'
pass 'a replica lease reads a table a migration created after setup (default privileges)'
revoke_as kilo_lease_replica_admin "$REPLICA_ADMIN_PW" "$RR3"

open_session "$CM1" "$CM1_PW" "/tmp/$NAME-cm1.log"
wait_for_session "$CM1"
revoke_as kilo_lease_migration_admin "$MIGRATION_ADMIN_PW" "$CM1"
if wait "$SESSION"; then fail 'the open migration session is ended'; fi
[ "$(role_count "$CM1")" = 0 ] || fail 'migration revocation drops the role'
pass 'migration revocation ends the open session and drops the role'
if sql kilo_lease_migration_admin "$MIGRATION_ADMIN_PW" -c 'select 1 from public.accounts' >/dev/null 2>&1; then
  fail 'migration admin cannot read accounts'
fi
pass 'the migration admin holds none of the template rights itself'

# Why revoke.sql ends sessions before DROP ROLE: the drop succeeds with a session open, the
# session lives on, and pg_stat_activity no longer names its user, so nothing finds it by name.
RR4=$(role_name rr)
RR4_PW=$(secret)
create_replica "$RR4" "$RR4_PW" "$(expires_in 300)"
open_session "$RR4" "$RR4_PW" "/tmp/$NAME-rr4.log"
wait_for_session "$RR4"
PID=$(super -c "select pid from pg_stat_activity where usename = '$RR4'")
super -c "drop role \"$RR4\"" >/dev/null
[ "$(super -c "select count(*) from pg_stat_activity where pid = $PID and usename is null")" = 1 ] || fail 'the dropped role keeps an unnamed session'
pass 'DROP ROLE alone leaves the session open and unnamed, so revocation terminates first'
super -c "select pg_terminate_backend($PID)" >/dev/null
wait "$SESSION" || true

echo 'ALL PASS'
