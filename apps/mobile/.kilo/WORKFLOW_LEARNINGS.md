# Workflow Learnings

Environment blockers and their fixes, recorded by the planner or orchestrator for the role that hit them. The full contract — when to read, when to write, entry shape, deduplication — is in [MOBILE_WORKFLOW.md](MOBILE_WORKFLOW.md).

## Planner

## Orchestrator

### PR-review E2E env traps (stub token path)

- **Symptom:** `githubApps.devSeedUserGithubToken` fails or the app shows
  `GitHub connection expired` even after seeding; the GitHub stub never logs
  a request.
- **Cause:** (1) worktree `.env.local` missing the `USER_GITHUB_APP_TOKEN_*`
  encryption keys, so the seeded token cannot be encrypted/decrypted; (2)
  `services/git-token-service/.dev.vars` has empty token keys, so the token
  endpoint returns 503.
- **Fix:** copy the missing `USER_GITHUB_APP_TOKEN_*` key lines from the
  primary checkout's `.env.local` (temporary, strip after the run), fill the
  empty keys in `services/git-token-service/.dev.vars`, restart
  git-token-service + nextjs, re-seed, then reopen the PR in the app (a
  "Check connection" retry alone may not refetch after the first 412s).
- **Also:** iOS shows an `Allow Paste` prompt before the PR-URL paste lands;
  and the Safari `Open this page in "Kilo"?` wording can differ from the
  settle-app regex — tap the exact `Open` accessibility action instead.
