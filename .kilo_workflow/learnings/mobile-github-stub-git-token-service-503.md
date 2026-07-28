# mobile: "GitHub connection expired" against hermetic stub = git-token-service 503

Symptom: PR-review E2E with the hermetic GitHub stub opens the PR then stalls on "GitHub connection expired / Check connection"; the stub request log shows only the first `pulls/<n>` fetch; nextjs logs repeated `githubPrReview.getPullRequest 412`.

Cause: `withGitHubUserTokenRetry` resolves the user's GitHub token through git-token-service before any outbound call; the service's `POST /internal/github-user-authorizations/token` returned `503 authentication_unavailable` because its `NEXTAUTH_SECRET_DEV` Secrets Store binding had never been created in this worktree (Secrets Store state is local to each Worker directory). A missing-URL or key-drift `USER_GITHUB_APP_TOKEN_*` envelope produces the same 412 surface.

Fix: `pnpm dev:env -y cloudflare-git-token-service` (creates `NEXTAUTH_SECRET_DEV` and syncs the `USER_GITHUB_APP_TOKEN_*` envelope into the worker env from root `.env.local`), then `pnpm dev:restart cloudflare-git-token-service`. Smoke with an authenticated `GET /api/trpc/githubPrReview.getPullRequest?...owner=kilo-stub...` — expect 200, not 412. Note nextjs reads `GIT_TOKEN_SERVICE_API_URL` from `apps/web/.env.development.local`, not from root `.env.local`.
