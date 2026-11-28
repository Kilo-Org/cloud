# ai-gateway

Next.js app that serves the AI gateway API on its own. It deploys to the
`kilocode-ai-gateway` Vercel project, whose functions run in `fra1` and `sfo1`
(`vercel.mjs`), at `ai-gateway.kilo.ai` and `staging-ai-gateway.kilo.ai`.

This app is the only server of the gateway API. `apps/web` has no gateway routes;
it rewrites its legacy gateway paths here (`apps/web/ai-gateway-rewrites.mjs`) in
every environment: the matching gateway on Vercel's production and staging targets,
`AI_GATEWAY_URL` when set, and otherwise the local app on its `dev:start` port.
`apps/web/ai-gateway-rewrites.test.mjs` checks that every route here is reachable
through those paths and that no `apps/web` route is shadowed by a rewrite.

- Every route lives under `/api/v1`. There are no `/api/gateway` or `/api/openrouter`
  aliases. Each `apps/web` route maps to the path without that prefix, and the
  `v1` variants in `apps/web` collapse into the same route: `/api/gateway/v1/models`
  and `/api/openrouter/models` both become `/api/v1/models`. `/api/fim`,
  `/api/organizations` and the typesafe `/api/gateway/typesafe/v1/systemone`
  move under `/api/v1` too; the latter becomes `/api/v1/systemone`.
- Tests live next to the routes and run in the `apps/web` Jest suite, which
  includes this app as a root. Import from this app and `@kilocode/web-shared`
  only; `@/` resolves to `apps/web` there.
- `sfo1` is far from the Frankfurt primary database; follow "AI gateway
  database access" in `packages/web-shared/AGENTS.md`.
- Route files are thin facades over handlers in `packages/web-shared`. Keep the
  `apps/web` `maxDuration` and `withRestTiming` usage, with route patterns that
  match this app's paths. Import them as `@kilocode/web-shared/…`; see
  `packages/web-shared/AGENTS.md`.
- Callers authenticate by bearer token only. `next.config.mjs` inlines
  `KILO_BROWSER_SESSIONS=disabled` at build time, so the shared auth code never
  reads the NextAuth session cookie here: a request without a bearer is
  anonymous, even when the `apps/web` rewrite forwards a signed-in browser's
  cookie. The Jest setup applies the same value to this app's tests.
  `NEXTAUTH_SECRET` must stay set on the `kilocode-ai-gateway` project: it
  verifies HS256 bearer tokens. It is no longer checked at boot, so a missing
  value shows up as every bearer token being refused.
- `next.config.mjs` also inlines `KILO_STS_WORKLOAD=ai-gateway`: the US-region
  usage handoffs and the Claude payer-state read send an STS token under
  `WEB_INTERNAL_SENDER_AUTH=sts` only from this build. STS refuses `kilocode-app`
  a token for its own `web` audience.
- Requests only arrive here under `/api/v1`. The LLM proxy's path validation
  accepts only `/api/v1` and rejects the legacy `apps/web` prefixes.
- `pnpm dev` runs with the web app's environment files. `pnpm dev:start`
  starts it with the web app and points the web app's rewrites at it.
- The automatic `deploy-production.yml` and `deploy-staging.yml` pipelines
  deploy this app with the web apps, from the same CI-green commit. Production
  promotes the gateway only after the migrations finish; staging starts the
  deploy beside the migration gate, so a slow staging migration can finish after
  the new gateway is reachable. A release is only recorded as complete once the
  gateway is live too.
  `redeploy-web.yml` does not touch this app. Crons stay on the web app; do not
  add them to this app's `vercel.mjs`.
- Server-side Sentry and OpenTelemetry come from
  `packages/web-shared/src/lib/observability`, registered in
  `src/instrumentation.ts` with the `kilocode-ai-gateway` service name. The app
  has no client or Edge runtime code, so it has no client or Edge Sentry config.
- `src/instrumentation.ts` also installs the shared `INTERNAL_API_SECRET` read
  (`packages/web-shared/src/lib/sts-secret-reader.ts`), so every internal call this app
  sends or receives follows `SECRETS_SOURCE` on the `kilocode-ai-gateway` project
  (`ENVIRONMENT.md`): unset or `env` keeps the environment variable, `sts` reads the
  `ai-gateway` STS bundle and never falls back. Read it through `readInternalApiSecret`,
  never the `config.server` constant. Keep the project on `env` until the `ai-gateway`
  policy grants `INTERNAL_API_SECRET` in that environment and the protected import of the
  value exists. Receivers answer a failed read with their generic unavailable status and do
  not log it; the shared reader's `sts_secret_read_failed` line, limited per reason on a best
  effort basis, is the one signal.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
