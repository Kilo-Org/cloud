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
- The body contract lives in `@kilocode/ai-gateway-secure-proxy-contracts`,
  shared with the gateway (`packages/web-shared/src/lib/ai-gateway/providers/secure-proxy.ts`).
- Keep it dependency-free: no database, Redis, Sentry, or workspace packages
  other than the contracts package.
- Tests run in the `apps/web` Jest suite, which includes this app as a root. Use
  relative imports in tests; `@/` resolves to `apps/web` there.
