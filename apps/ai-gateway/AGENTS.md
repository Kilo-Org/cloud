# ai-gateway

Next.js app that serves the AI gateway API on its own. It deploys to the
`kilocode-ai-gateway` Vercel project, whose functions run in `fra1` and `sfo1`
(`vercel.json`). `apps/web` still serves the same handlers under its own paths.

- Every route lives under `/api/v1`. There are no `/api/gateway` or `/api/openrouter`
  aliases. Each `apps/web` route maps to the path without that prefix, and the
  `v1` variants in `apps/web` collapse into the same route: `/api/gateway/v1/models`
  and `/api/openrouter/models` both become `/api/v1/models`. `/api/fim`,
  `/api/edit`, `/api/organizations` and the typesafe `/api/gateway/typesafe/v1/systemone`
  move under `/api/v1` too; the latter becomes `/api/v1/systemone`.
- Route files are thin facades over handlers in `packages/web-shared`. Keep the
  `apps/web` `maxDuration` and `withRestTiming` usage, with route patterns that
  match this app's paths. Import them as `@kilocode/web-shared/…`; see
  `packages/web-shared/AGENTS.md`.
- Handlers that depend on the path accept both apps' paths, such as the LLM
  proxy's path validation.
- `pnpm dev` runs with the web app's environment files. Start it with
  `pnpm dev:start ai-gateway`.
- The scheduled `deploy-production.yml` and `deploy-staging.yml` deploy this
  app with the web apps, from the same CI-green commit, after migrations. A
  release is only recorded as complete once the gateway is live too.
  `redeploy-web.yml` does not touch this app. Crons stay on the web app; do not
  add them to this app's `vercel.json`.
- Server-side Sentry and OpenTelemetry come from
  `packages/web-shared/src/lib/observability`, registered in
  `src/instrumentation.ts` with the `kilocode-ai-gateway` service name. The app
  has no client or Edge runtime code, so it has no client or Edge Sentry config.
