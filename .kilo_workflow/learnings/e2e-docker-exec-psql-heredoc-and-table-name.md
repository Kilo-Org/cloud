# e2e: docker exec psql drops heredocs without -i; users table is kilocode_users

Two Postgres-probe traps hit on session-list-ux-19e2 r4 (Android):

1. `docker exec dev-postgres-1 psql ... <<'SQL'` silently runs NOTHING without
   `-i` — psql reads EOF on the unattached stdin, exits 0, and every INSERT
   no-ops (no error, no row count). Handoffs that pipe heredocs into
   `docker exec` are broken as written. Use `psql ... -c "..."` (multi-statement
   strings are fine) or add `-i`.

2. The users table is `kilocode_users`, not `kilo_users` — handoff SQL with
   `kilo_users` errors `relation does not exist`. Resolve ids through
   `pnpm dev:seed app:user-id <email>` instead; it uses the worktree's
   configured database. The per-worktree app database in the shared postgres
   container can be identified by which `-d` candidate contains your user row
   (`postgres` for this worktree; siblings use `postgres-N`).
