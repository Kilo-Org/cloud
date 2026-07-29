# mobile: PR-review entry URL input is gated behind GitHub connection; seeding pitfalls

Symptom: deep-linking to `/(app)/pr-review` shows the "Connect GitHub" empty state instead of the URL input; `githubApps.devSeedUserGithubToken` then fails with a raw drizzle "Failed query: insert into user_github_app_tokens" (duplicate key on `UQ_user_github_app_tokens_github_user_app`).

Cause: (1) the entry screen only renders the URL input once the user has a GitHub token row; (2) all worktrees share ONE postgres database (named `postgres`, not `postgres-N` — check `pg_database`, sibling rows from other worktrees are visible), so the runbook's "stable fake githubUserId 999001" is usually already taken by a sibling's kilo_user_id; the upsert's ON CONFLICT target is (kilo_user_id, github_app_type), so a fresh user's INSERT collides on the github_user_id unique index and errors instead of returning `false`.

Fix: authenticate curl against nextjs via next-auth credentials fake-login as the mobile E2E user (GET /api/auth/csrf → POST /api/auth/callback/fake-login with csrfToken + email + json=true, cookie jar), then POST /api/trpc/githubApps.devSeedUserGithubToken with a FRESH githubUserId (e.g. 999002 — any unused value; the stub does not validate it). Relaunch the app afterwards so the connection query refetches.
