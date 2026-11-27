# ai-gateway-secure-proxy

Minimal Next.js app that relays custom LLM requests from the AI gateway to an
upstream. It deploys to the `kilocode-ai-gateway-secure-proxy` Vercel project, whose
functions run in `sfo1` only (`vercel.json`), via the manually triggered
`deploy-ai-gateway-secure-proxy.yml`.

- `KILO_AI_GATEWAY_SECURE_PROXY_CREDENTIAL_ACCEPT` selects the accepted credential
  (`src/lib/credential-admission.ts`). Unset or `legacy-only` is the original
  check: `Authorization: Bearer <KILO_AI_GATEWAY_SECURE_PROXY_SECRET>`, compared
  in constant time, 500 without the secret and 401 otherwise, with no verifier
  and no key-set fetch. `legacy-and-sts` also needs the secret (500 without it),
  compares it exactly first and sends only a non-matching request to the STS
  check. `sts-only` never reads the secret. `disabled` refuses every request;
  any other value answers 500.
- The STS check uses `@kilocode/verify` with `STS_SECURE_PROXY_FORWARD` from
  `@kilocode/sts-contracts` (audience `ai-gateway-secure-proxy`, scope
  `ai-gateway-secure-proxy:request.forward`) and admits only the `ai-gateway`
  service workload. The STS issuer and `env` claim come from the deployment's
  own Vercel labels (production: `VERCEL_ENV` and `VERCEL_TARGET_ENV` both
  `production`; staging: `VERCEL_TARGET_ENV=staging` without
  `VERCEL_ENV=production`), never from the request or the token. A preview has
  no STS environment. `KILO_AI_GATEWAY_SECURE_PROXY_ORIGIN` is the canonical
  origin, exactly `https://host[:port]` with no path, query, fragment or
  credentials; challenges name its metadata URL. A missing STS environment or
  origin answers 500 to every request that reaches the STS check: under
  `legacy-and-sts`, every request the secret does not match, including one
  without a bearer; under `sts-only`, every request. Only off Vercel,
  `KILO_AI_GATEWAY_SECURE_PROXY_LOCAL_STS_FIXTURE=1` selects the development
  issuer, with `http://localhost:3020` when no origin is set. A refusal is
  final and carries `Cache-Control: no-store`; a key-set outage answers 503
  with `Retry-After`.
- `GET /.well-known/oauth-protected-resource` serves the RFC 9728 metadata
  (that origin, this environment's STS issuer, the forward scope) only when the
  mode admits STS tokens and the STS environment and origin are valid;
  otherwise a plain 404.
- The gateway takes the shared secret from the custom LLM's `secure_proxy`
  credentials (`proxy_secret`). Vercel Deployment Protection is off, so the
  credential check is the only thing keeping the proxy from being an open
  relay; check it before reading the body.
- `POST /api/proxy` is the only relay route; it is API-agnostic. It reads
  `kilo_secure_proxy: { url, headers }` from the JSON body, removes it, and POSTs
  the remaining body to `url` with exactly `headers`. Incoming request headers
  are never forwarded; response headers pass through the same allowlist as the
  gateway's `wrapInSafeNextResponse`. Upstream redirects are not followed and
  become 502 errors.
- The body contract lives in `@kilocode/ai-gateway-secure-proxy-contracts`,
  shared with the gateway (`packages/web-shared/src/lib/ai-gateway/providers/secure-proxy.ts`).
- Keep it dependency-free: no database, Redis, Sentry, or workspace packages
  other than the contracts package, `@kilocode/verify` and
  `@kilocode/sts-contracts`.
- Tests use Vitest (`pnpm --filter ai-gateway-secure-proxy test`) and run in
  CI's per-workspace test job, independent of the `apps/web` Jest suite.
