# Dev Script Guide For AI Agents

Use the local fake-provider review flow first when debugging webhook-to-review behavior without a real repository. It exercises the Next.js webhook route, database routing, code-review Worker, reviewer Durable Object, cloud-agent-next Durable Object, and Docker sandbox. It avoids real GitHub/GitLab API and clone dependencies by using explicit local-only flags.

## Review Webhook Flow

1. Sync local dev env files after pulling changes:

```bash
pnpm dev:env code-review
```

2. Start the code-review stack with the local fake provider enabled:

```bash
CODE_REVIEW_LOCAL_FAKE_PROVIDER=1 KILO_PORT_OFFSET=auto pnpm dev:start --no-attach code-review
```

3. Seed fake integrations and refresh the tracked webhook fixtures:

```bash
pnpm dev:seed review:webhook-fixtures
```

4. Send a signed GitHub pull request webhook and verify the generated review prompt reached fake-LLM:

```bash
VERIFY_FAKE_LLM=1 ./dev/review/test-review-webhook.sh --github
```

5. Send a GitLab merge request webhook and verify the generated review prompt reached fake-LLM:

```bash
VERIFY_FAKE_LLM=1 ./dev/review/test-review-webhook.sh --gitlab
```

Re-run `pnpm dev:seed review:webhook-fixtures` before repeating a fixture webhook. Review rows are unique by repo, PR/MR number, and head SHA, so reseeding clears the previous fixture review and webhook dedupe rows.

## What The Fake Flag Does

`CODE_REVIEW_LOCAL_FAKE_PROVIDER=1` is local-only and should not be used for production-like provider API testing.

| Component | Behavior |
|---|---|
| Next.js webhook/review code | Skips GitHub/GitLab provider token reads, check/status writes, reactions, comments, repository size reads, and `REVIEW.md` reads. |
| Next.js and code-review Worker | The dev runner injects matching local `CALLBACK_TOKEN_SECRET` values so callback status updates work without interactive `dev:env`. |
| cloud-agent-next | Wrangler receives `KILOCODE_DEV_FAKE_REPOSITORY=1` and creates a synthetic git origin/ref inside the sandbox instead of cloning GitHub/GitLab. |
| fake-LLM | Wrangler receives `KILO_OPENROUTER_BASE=http://localhost:<fake-llm-port>/api`; seeded prompts include `__fake__:idle` so no `gh`/`glab` CLI call is attempted. |
| test script | Discovers the active Next.js and fake-LLM ports with `pnpm dev:status --json`; never assumes port `3000`. |

## Fixture Files

The review webhook fixtures are tracked canonical examples:

- `dev/review/fixtures/github-pull-request-opened.json`
- `dev/review/fixtures/gitlab-merge-request-open.json`

`pnpm dev:seed review:webhook-fixtures` refreshes these files and resets the local fixture rows. The fixtures are based on GitHub pull request and GitLab merge request webhook shapes and include the fields the local handlers require.

## Sending Custom Payloads

Use captured payloads with the same sender script:

```bash
./dev/review/test-review-webhook.sh --github /path/to/github-payload.json
./dev/review/test-review-webhook.sh --gitlab /path/to/gitlab-payload.json
```

Payloads wrapped as `{"event":"...","payload":{...}}` are unwrapped automatically. Override `EVENT_TYPE`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, or `GITLAB_WEBHOOK_TOKEN` only when testing non-default routes or captured deliveries.

For GitHub, the script signs the body with `WEBHOOK_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`, or `GITHUB_APP_WEBHOOK_SECRET` parsed from `.env.local`. For GitLab, the seeded token is `dev-review-gitlab-webhook-secret`.

## Real Provider Flow

Use smee.io when you intentionally need real GitHub or GitLab provider behavior, including installation token generation, check/status updates, reactions, comments, `REVIEW.md`, and real repository cloning.

1. Start the relevant local stack without `CODE_REVIEW_LOCAL_FAKE_PROVIDER=1`.
2. Create a channel at [smee.io](https://smee.io).
3. Forward GitHub webhooks locally:

```bash
npx smee-client \
  --url https://smee.io/<channel-id> \
  --target http://127.0.0.1:<nextjs-port>/api/webhooks/github
```

4. Trigger a real provider event and save the delivered JSON payload.
5. Replay it with `./dev/review/test-review-webhook.sh --github payload.json` or the GitLab equivalent.

Get `<nextjs-port>` from `pnpm dev:status --json` or `dev/logs/manifest.json`.

## Script Map

- Review flow: `./dev/review/test-review-webhook.sh [--github|--gitlab] [payload.json|-]`
- Legacy fixed-port review script: `./dev/review/dev-review.sh`
- Auto-fix flow: `./dev/auto-fix/dev-auto-fix.sh`
- Auto-fix webhook sender: `./dev/auto-fix/test-auto-fix-webhook.sh [payload.json]`

## Logs

- Dev manifest: `dev/logs/manifest.json`
- Next.js logs: `dev/logs/nextjs.log`
- Code-review Worker logs: `dev/logs/cloudflare-code-review-infra.log`
- cloud-agent-next logs: `dev/logs/cloud-agent-next.log`
- fake-LLM logs: `dev/logs/fake-llm.log`
