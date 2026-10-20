# ai-gateway-secure-proxy

Minimal Next.js app that relays custom LLM requests from the AI gateway to an
upstream. It deploys to the `kilocode-ai-gateway-secure-proxy` Vercel project, whose
functions run in `sfo1` only (`vercel.json`), via the manually triggered
`deploy-ai-gateway-secure-proxy.yml`.

- Every request must carry `Authorization: Bearer <KILO_AI_GATEWAY_SECURE_PROXY_SECRET>`,
  compared in constant time. The gateway takes the value from the custom LLM's
  `secure_proxy` credentials (`proxy_secret`). Without the env var the app
  rejects every request. Vercel Deployment Protection is off, so this check is
  the only thing keeping the proxy from being an open relay; check
  authorization before reading the body.
- `POST /api/proxy` is the only route; it is API-agnostic. It reads
  `kilo_secure_proxy: { url, headers }` from the JSON body, removes it, and POSTs
  the remaining body to `url` with exactly `headers`. Incoming request headers
  are never forwarded; response headers pass through the same allowlist as the
  gateway's `wrapInSafeNextResponse`. Upstream redirects are not followed and
  become 502 errors.
- The deployment workflow targets production only. Shared URL policy activation
  is outside that deployed target: `@kilocode/upstream-url-policy` and its
  approved-address dispatcher activate only with `VERCEL_TARGET_ENV=staging`.
  That runtime selection is exercised locally; there is no relay staging
  deployment configured in this repository.
- The body contract lives in `@kilocode/ai-gateway-secure-proxy-contracts`,
  shared with the gateway (`packages/web-shared/src/lib/ai-gateway/providers/secure-proxy.ts`).
- Keep it dependency-free: no database, Redis, Sentry, or workspace packages
  other than the contracts package and `@kilocode/upstream-url-policy`, which is
  plain Node code (no database, Redis, or Sentry) that gives the relay the same
  upstream URL rules the gateway uses.
- Tests use Vitest (`pnpm --filter ai-gateway-secure-proxy test`) and run in
  CI's per-workspace test job, independent of the `apps/web` Jest suite.
