# ai-gateway-secure-proxy

Minimal Next.js app that relays custom LLM requests from the AI gateway to an
upstream. It deploys to the `ai-gateway-secure-proxy` Vercel project, whose
functions run in `sfo1` only (`vercel.json`), via the manually triggered
`deploy-ai-gateway-secure-proxy.yml`.

- Access is gated by Vercel Deployment Protection, which must cover production.
  The gateway sends a Protection Bypass for Automation secret as
  `x-vercel-protection-bypass`, taken from the custom LLM's `secure_proxy`
  credentials. The app itself performs no authentication.
- `POST /api/v1/{chat/completions,responses,messages}` all behave the same: read
  `kilo_secure_proxy: { url, headers }` from the JSON body, remove it, and POST
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
