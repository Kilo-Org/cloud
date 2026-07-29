# mobile: devSeedUserGithubToken 500s when a sibling e2e user already owns github_user_id 999001

Symptom: `githubApps.devSeedUserGithubToken` with `githubUserId: "999001"` returns a 500
("Failed query: insert into user_github_app_tokens ... on conflict ..."), even though the
runbook says a sibling seed should surface as a benign `upserted: false`.

Cause: the local postgres on this machine is SHARED across worktrees (this worktree's stack
used the base `postgres` DB on localhost:5432 — the `postgres-N` DBs belong to other flows;
find yours via `select count(*) from user_auth_provider where provider_account_id='<e2e email>'`
across DBs). A previous section seeded github_user_id 999001 for a DIFFERENT kilo_user_id
(`e2e-mobile-mobile-audit-w1-pr-safety@example.com`). The upsert targets
(kilo_user_id, github_app_type); with no row for YOUR user it attempts a plain insert, which
violates unique index `UQ_user_github_app_tokens_github_user_app` on (github_user_id, app_type).

Fix: list existing ids first —
`psql -h localhost -p 5432 -U postgres -d postgres -c "select github_user_id, github_login from user_github_app_tokens"`
— and seed with a FREE id (999003 worked). The github_user_id value only feeds the token
envelope AAD, which round-trips through the same row, so any unique value works against the stub.

Also: the seed mutation needs an authenticated call. The web fake-login cookie path did NOT
satisfy tRPC (`UNAUTHORIZED`). Working path with curl, same as the app's own native login:
`POST /api/auth/native/otp {email}` → read the 6-digit code from the newest `dev/logs/emails/*.html`
→ `POST /api/auth/native/token {provider:'email', email, code}` → `{token}` → call tRPC with
`Authorization: Bearer <token>`.
