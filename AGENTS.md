# AGENTS.md

This document is for AI coding agents and operators working on the kilocode-backend codebase. It contains operational runbooks for emergency procedures and key system behaviors.

---

## Emergency: Routing All Traffic to Vercel

### What it does

`ENABLE_UNIVERSAL_VERCEL_ROUTING` is a hardcoded boolean constant in [`src/lib/providers/vercel.ts`](src/lib/providers/vercel.ts:25). When set to `true`, it forces **all LLM traffic that would normally go to OpenRouter** to be routed through the Vercel AI Gateway instead.

Under normal operation, only models on the `VERCEL_ROUTING_ALLOW_LIST` are eligible for Vercel routing, and even those are probabilistically split between OpenRouter and Vercel based on real-time error rates. Enabling universal routing bypasses the allow list and sends all OpenRouter-bound traffic to Vercel unconditionally.

### When to use it

- OpenRouter is experiencing a **major outage** affecting users.
- The automatic failover (error-rate-based routing in [`getVercelRoutingPercentage()`](src/lib/providers/vercel.ts:51)) is **not recovering traffic** adequately — e.g., the outage is too sudden or the error rate query is timing out.

### How to enable it

1. Open [`src/lib/providers/vercel.ts`](src/lib/providers/vercel.ts:25).
2. Change the constant from `false` to `true`:
   ```ts
   const ENABLE_UNIVERSAL_VERCEL_ROUTING = true;
   ```
3. Commit, push, and deploy.

This is a **code change**, not an environment variable. It requires a deploy to take effect.

### How to revert

1. Set the constant back to `false`:
   ```ts
   const ENABLE_UNIVERSAL_VERCEL_ROUTING = false;
   ```
2. Commit, push, and deploy.

### Caveats and side effects

- **Model coverage gaps.** Many models available on OpenRouter are not available on Vercel, are named differently, or have not been tested. The [`vercelModelIdMapping`](src/lib/providers/vercel.ts:111) handles some remappings, but coverage is incomplete. Expect some models to fail.
- **`data_collection=deny` requests are excluded.** Requests with `provider.data_collection === 'deny'` are never routed to Vercel regardless of this flag — they will still attempt OpenRouter. See [`shouldRouteToVercel()`](src/lib/providers/vercel.ts:75).
- **BYOK users are unaffected.** Users with their own API keys (BYOK) are already routed to Vercel via a separate code path in [`getProvider()`](src/lib/providers/index.ts:132) and are not impacted by this switch.
- **Cost and rate limits may differ.** Vercel AI Gateway has its own rate limits and pricing structure. A sudden shift of all traffic may hit Vercel rate limits that weren't an issue under normal split routing.
- **Provider option translation.** OpenRouter provider preferences (`only`, `order`, `zdr`) are translated to Vercel equivalents via [`convertProviderOptions()`](src/lib/providers/vercel.ts:99), but not all OpenRouter provider IDs have Vercel equivalents.

---

## Automatic Failover (Background)

The system has built-in automatic failover that operates independently of the emergency switch:

- [`getGatewayErrorRate()`](src/lib/providers/gateway-error-rate.ts:32) queries the last 10 minutes of usage data to compute error rates for both OpenRouter and Vercel. Results are cached for 60 seconds.
- If OpenRouter's error rate exceeds 50% **and** Vercel's is below 50%, the system routes **90%** of allow-listed traffic to Vercel (up from the default 10%).
- Traffic splitting uses a deterministic hash of the user/task ID, so a given user gets consistent routing within a cache window.
- If the error rate query times out (500ms) or fails, it defaults to `0` for both providers — meaning no automatic failover occurs. This is a known limitation and one reason the manual emergency switch exists.
