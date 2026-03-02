# llm-gateway Worker — Phase 2 Plan (Stub Completion)

PR #724 landed the `@kilocode/llm-shared` package and the `llm-gateway` worker scaffold
with the full 17-step request flow wired up. Several services were stubbed. This document
covers everything needed to reach feature parity with the Next.js route.

---

## Phase A: Usage Accounting

**Stub**: `llm-gateway/src/background/usage-accounting.ts` — currently a no-op.

Port `countAndStoreUsage` from `src/lib/processUsage.ts`. This is the largest piece of
work because it touches many tables and external services.

### Steps

1. **Parse usage from response** — use `eventsource-parser` to walk SSE events from the
   cloned response. Extract `usage` (token counts, cost), `model`, `messageId`,
   `provider`, `finish_reason`, and aggregate `responseContent`. For non-streaming
   responses, parse the full JSON body.

2. **Fetch authoritative cost from OpenRouter** — call the `/generation` endpoint
   (`fetchGeneration` in `src/lib/providers/index.ts:336`) to reconcile cost data. The
   worker makes this as a plain `fetch()` with the OpenRouter API key.

3. **Report cost to abuse service** — fire-and-forget `POST /api/usage/cost` with
   `request_id`, `message_id`, `cost`, and token counts. Shares the abuse service client
   from Phase B.

4. **Zero-cost logic** — zero out cost for free models, BYOK users, and active promotions
   (review promo, cloud agent promo). This logic already exists in `@kilocode/llm-shared`.

5. **Insert usage record** — port `insertUsageAndMetadataWithBalanceUpdate`
   (`src/lib/processUsage.ts:483–644`), a single SQL CTE that atomically:
   - Inserts into `microdollar_usage`.
   - Upserts 9 normalized lookup tables (`http_user_agent`, `http_ip`,
     `vercel_ip_country`, `vercel_ip_city`, `ja4_digest`, `system_prompt_prefix`,
     `finish_reason`, `editor_name`, `feature`).
   - Inserts into `microdollar_usage_metadata`.
   - Updates `kilocode_users.microdollars_used` (for non-org, positive-cost usage).
   - Returns new balance and `kilo_pass_threshold`.

6. **Organization token usage** — port `ingestOrganizationTokenUsage`
   (`src/lib/organizations/organization-usage.ts:209`). Within a transaction:
   - Increment `organizations.microdollars_used`, decrement
     `organizations.microdollars_balance`.
   - Upsert `organization_user_usage` (per-user daily tracking).
   - Check `minimum_balance` threshold → fire alert email if crossed.

7. **Kilo Pass threshold check** — if `insertUsageAndMetadataWithBalanceUpdate` returns a
   crossed threshold, fire `maybeIssueKiloPassBonusFromUsageThreshold`
   (`src/lib/kilo-pass/usage-triggered-bonus.ts:296`) in `ctx.waitUntil()`.

8. **PostHog events** — `posthog-node` is not Workers-compatible. Use the PostHog HTTP
   Capture API directly (`POST https://us.i.posthog.com/capture/`) for `first_usage` and
   `first_microdollar_usage` events. Add `POSTHOG_API_KEY` to wrangler.jsonc secrets.

### New dependencies

- `eventsource-parser` (already used in the Next.js app)

### DB tables written

`microdollar_usage`, `microdollar_usage_metadata`, 9 lookup tables, `kilocode_users`,
`organizations`, `organization_user_usage`, `kilo_pass_*` tables (via threshold bonus).

---

## Phase B: Abuse Classification

**Stub**: `llm-gateway/src/services/abuse.ts` — returns `null` (fail-open).

Port the HTTP call to the abuse service from `src/lib/abuse-service.ts`.

### Steps

1. **Classify request** — `POST ${ABUSE_SERVICE_URL}/api/classify` with:
   - CF Access headers (`CF-Access-Client-Id`, `CF-Access-Client-Secret`)
   - Payload: identity fields (`kilo_user_id`, `organization_id`, `project_id`), network
     fingerprints (`ip_address`, geo fields, `ja4_digest`, `user_agent`), model info
     (`provider`, `requested_model`), full prompts (`user_prompt`, `system_prompt`),
     request metadata (`max_tokens`, `has_tools`, `streamed`, `is_user_byok`,
     `editor_name`).

2. **Response handling** — parse `AbuseClassificationResponse` (`verdict`, `risk_score`,
   `signals`, `action_metadata`, `context`, `request_id`). Attach `request_id` to usage
   context.

3. **Report cost** — `POST ${ABUSE_SERVICE_URL}/api/usage/cost` (also called from
   Phase A). Same CF Access headers. Payload: `request_id`, `message_id`, `cost`,
   token counts.

4. **Fail-open** — on timeout (2s) or error, return `null` so the request proceeds.

### New wrangler.jsonc secrets

```jsonc
{
  "binding": "ABUSE_SERVICE_URL",
  "secret_name": "ABUSE_SERVICE_URL",
  "store_id": "342a86d9e3a94da698e82d0c6e2a36f0"
},
{
  "binding": "ABUSE_SERVICE_CF_ACCESS_CLIENT_ID",
  "secret_name": "ABUSE_SERVICE_CF_ACCESS_CLIENT_ID",
  "store_id": "342a86d9e3a94da698e82d0c6e2a36f0"
},
{
  "binding": "ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET",
  "secret_name": "ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET",
  "store_id": "342a86d9e3a94da698e82d0c6e2a36f0"
}
```

---

## Phase C: Response Transforms

**Missing**: neither `rewriteFreeModelResponse` nor `makeErrorReadable` exist in the
worker.

### C1: `rewriteFreeModelResponse`

Port from `src/lib/rewriteModelResponse.ts:35–123`. Applied to free models, review promos,
and cloud agent promos (when provider is not `custom`).

**JSON responses**: replace `response.model` with the requested model ID, convert
`reasoning_content` to `reasoning` + `reasoning_details` (OpenRouter format), strip
`cost`/`cost_details`/`is_byok` from usage.

**SSE streams**: create a `TransformStream` that rewrites each SSE event:

- Replace `model` with requested model ID.
- Delete `delta.role` if null.
- Convert reasoning format.
- Ensure `choices` array is always present.
- Strip cost info from usage chunks.
- Pass through SSE comments as `: KILO PROCESSING\n\n`.
- Append `data: [DONE]\n\n` at end.

### C2: `makeErrorReadable`

Port from `src/lib/llm-proxy-helpers.ts:131–174`. Applied to all error responses
(status >= 400) before returning to the client.

- **BYOK errors**: map 401 → invalid key, 402 → insufficient funds, 403 → bad
  permissions, 429 → rate limit.
- **Context length exceeded**: for Kilo free models, estimate tokens and compare against
  model's `context_length`. Return a clear message.
- **Stealth model errors**: for `isKiloStealthModel`, return a generic error hiding the
  model identity.

### Integration point

Both transforms are applied in `routes/chat-completions.ts` step 17, between receiving the
upstream response and returning to the client. `makeErrorReadable` runs first (on errors),
then `rewriteFreeModelResponse` (on success for free/promo models).

---

## Phase D: BYOK Provider Lookup + KV Cache

**Missing**: `getProvider` always returns `userByok: null`. The `BYOK_CACHE` KV binding is
declared but unused.

### Steps

1. **Port BYOK lookup queries** — `getBYOKforUser` and `getBYOKforOrganization` from
   `src/lib/byok/index.ts`. Query `byok_api_keys` table for enabled keys matching the
   user/org and provider ID.

2. **Port `decryptApiKey`** — from `src/lib/byok/encryption.ts`. AES-256-GCM decryption.
   Workers support `crypto.subtle` for AES-GCM; port from Node.js `crypto` module to
   Web Crypto API (`crypto.subtle.decrypt`).

3. **Port `getModelUserByokProviders`** — query `models_by_provider` table for Vercel
   model metadata, filter through `VercelUserByokInferenceProviderIdSchema`.

4. **KV caching** — replace `unstable_cache` with `BYOK_CACHE` KV binding:
   - Key: `byok-providers:${modelId}` (for provider ID lookups, 5-min TTL).
   - Key: `byok-keys:${userId}:${providerId}` or
     `byok-keys:org:${orgId}:${providerId}` (for decrypted keys, 5-min TTL).
   - On cache miss, query Hyperdrive and write to KV.

5. **Wire into `getProvider`** — if BYOK keys are found, route to
   `PROVIDERS.VERCEL_AI_GATEWAY` and set `userByok` on the result.

### New wrangler.jsonc secret

```jsonc
{
  "binding": "BYOK_ENCRYPTION_KEY",
  "secret_name": "BYOK_ENCRYPTION_KEY",
  "store_id": "342a86d9e3a94da698e82d0c6e2a36f0",
}
```

### KV namespace

Create the `BYOK_CACHE` KV namespace and update the `id` in `wrangler.jsonc` (currently
`<to-be-created>`).

---

## Phase E: Vercel AI Gateway Routing

**Missing**: `shouldRouteToVercel` was not extracted into `@kilocode/llm-shared` and is not
called in the worker.

### Steps

1. **Extract `shouldRouteToVercel`** into `@kilocode/llm-shared` — from
   `src/lib/providers/vercel/index.ts:53–92`. The function is mostly pure logic
   (preferred model list, anthropic exclusion, data_collection check). The only
   impure dependency is `getGatewayErrorRate`.

2. **Port `getGatewayErrorRate`** — query `microdollar_usage_view` via Hyperdrive for
   error rates of `openrouter` and `vercel` over the last 10 minutes. Cache in KV with
   60s TTL (replacing `unstable_cache`). Key: `gateway-error-rate`.

3. **Wire into `getProvider`** — after checking BYOK and custom LLM, call
   `shouldRouteToVercel` to decide whether to use `PROVIDERS.VERCEL_AI_GATEWAY`.

4. **Add Vercel AI Gateway API key** to wrangler.jsonc secrets if not already present.

---

## Phase F: Custom LLM (AI SDK)

**Stub**: `llm-gateway/src/services/custom-llm.ts` — returns HTTP 501.

Port `customLlmRequest` from `src/lib/custom-llm/customLlmRequest.ts`.

### Steps

1. **Message conversion** — port `convertMessages` (OpenRouter format → AI SDK
   `ModelMessage[]`). Handles system/user/assistant/tool roles, reasoning details
   (encrypted/text), tool calls, image/file/audio parts.

2. **Tool conversion** — port `convertTools` using AI SDK `jsonSchema`.

3. **Model creation** — port `createModel`: pick `createAnthropic` or `createOpenAI`
   based on `customLlm.provider`, using the custom LLM's `api_key` and `base_url`.
   For OpenAI with native base URL, patch fetch to inject `phase` params from
   `temp_phase` DB table (Hyperdrive query).

4. **Common params** — port `buildCommonParams`: provider options including
   `anthropic.thinking`, `verbosity`, `reasoningEffort`, `disableParallelToolUse`,
   `openai.forceReasoning`, `promptCacheKey`, `safetyIdentifier`.

5. **Non-streaming** — call `generateText`, convert result to OpenRouter-compatible JSON
   via `convertGenerateResultToResponse`, return `Response.json(...)`.

6. **Streaming** — call `streamText` with `includeRawChunks: true`, iterate
   `result.fullStream`, convert each `TextStreamPart` to an OpenRouter-format
   `ChatCompletionChunk` via `createStreamPartConverter`. Handle `text-delta`,
   `reasoning-start/delta/end`, `tool-input-start/delta`, `tool-call`, `finish-step`.
   Emit SSE `data: {...}\n\n` format. Return `new Response(stream, { headers })`.

7. **`NextResponse` → `Response`** — 3 `.json()` calls and 1 streaming `new Response()`.

### DB tables read

`custom_llm`, `temp_phase`.

### Key differences from Next.js

The AI SDK uses standard `fetch` internally and is documented as edge-compatible. The main
risk is `temp_phase` DB access — route through Hyperdrive.

---

## Phase G: Organization Balance + Usage Limit Response

**Stub**: `llm-gateway/src/services/balance.ts` — returns `{ balance: Infinity }` for org
users. The 402 response uses a hardcoded message.

### Steps

1. **Port `getBalanceForOrganizationUser`** — from
   `src/lib/organizations/organization-usage.ts:52`. Joins `organizations` →
   `organization_memberships` → `organization_user_limits` → `organization_user_usage`.
   Computes org balance from `total_microdollars_acquired - microdollars_used`, applies
   credit expiration (`processOrganizationExpirations`), applies per-user daily caps.

2. **Port org settings** — return `settings.model_allow_list`,
   `settings.provider_allow_list`, `settings.data_collection` from the `organizations`
   row. These are already consumed in `checkOrganizationModelRestrictions` (shared
   package).

3. **Port `usageLimitExceededResponse`** — from `src/lib/llm-proxy-helpers.ts:67–88`.
   Query `credit_transactions` via `summarizeUserPayments` to determine if the user has
   ever paid. Show different messages for first-time vs returning users.

### DB tables read

`organizations`, `organization_memberships`, `organization_user_limits`,
`organization_user_usage`, `credit_transactions`, `kilo_pass_issuance_items`.

---

## Phase H: Request Logging

**Stub**: `llm-gateway/src/background/request-log.ts` — no-op.

Port `handleRequestLogging` from `src/lib/handleRequestLogging.ts:8–46`.

### Steps

1. Check if user is a Kilo employee (email ends in `@kilo.ai` or `@kilocode.ai`, or is in
   the Kilo organization).
2. If yes, insert into `api_request_log` table with: `kilo_user_id`, `organization_id`,
   `status_code`, `model`, `provider`, full request JSON, full response text.
3. Run in `ctx.waitUntil()` (already wired up in the handler).

### DB table written

`api_request_log`.

---

## Phase I: Tests

**Missing**: zero test files exist. `vitest.config.ts` is present but
`@cloudflare/vitest-pool-workers` is not in devDependencies.

### Steps

1. **Add `@cloudflare/vitest-pool-workers`** to `llm-gateway/package.json`
   devDependencies. Update `vitest.config.ts` to use the Workers pool.

2. **Unit tests** (pure logic, no bindings):
   - Auth: JWT validation with valid/invalid/expired tokens, pepper mismatch, blocked
     users.
   - Provider selection: each provider type (OpenRouter, Vercel, BYOK, custom LLM, free
     model gateway).
   - Rate limit: threshold checks, promotion limits.
   - Request body mutations: `stream_options` injection, tool repair, provider-specific
     logic.
   - Response rewriting: `rewriteFreeModelResponse` (JSON + SSE), `makeErrorReadable`
     (BYOK errors, context length, stealth).
   - Abuse classification: payload construction, fail-open on timeout.

3. **Integration tests** (`@cloudflare/vitest-pool-workers`):
   - Full handler tests with mocked upstream providers.
   - Hyperdrive PG integration with test database.
   - KV cache read/write for BYOK.
   - `ctx.waitUntil()` background task execution and verification.
   - Custom LLM with mocked AI SDK providers.

---

## New wrangler.jsonc Secrets (All Phases)

| Binding                                 | Secret Name                             | Phase |
| --------------------------------------- | --------------------------------------- | ----- |
| `BYOK_ENCRYPTION_KEY`                   | `BYOK_ENCRYPTION_KEY`                   | D     |
| `ABUSE_SERVICE_URL`                     | `ABUSE_SERVICE_URL`                     | B     |
| `ABUSE_SERVICE_CF_ACCESS_CLIENT_ID`     | `ABUSE_SERVICE_CF_ACCESS_CLIENT_ID`     | B     |
| `ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET` | `ABUSE_SERVICE_CF_ACCESS_CLIENT_SECRET` | B     |
| `POSTHOG_API_KEY`                       | `POSTHOG_API_KEY`                       | A     |
| `O11Y_SERVICE_URL`                      | `O11Y_SERVICE_URL`                      | A     |
| `O11Y_CLIENT_SECRET`                    | `O11Y_CLIENT_SECRET`                    | A     |

All use the existing secrets store (`342a86d9e3a94da698e82d0c6e2a36f0`).

---

## Suggested Order

Phases are mostly independent, but some share code:

1. **B** (Abuse) — unblocks the abuse client used by both classification and cost
   reporting.
2. **C** (Response Transforms) — no dependencies, high user-facing impact.
3. **D** (BYOK) — unblocks paying BYOK users.
4. **E** (Vercel Routing) — depends on D for BYOK context.
5. **G** (Org Balance) — unblocks org users hitting the `Infinity` balance stub.
6. **A** (Usage Accounting) — depends on B (cost reporting) and benefits from G (org
   usage). Largest scope.
7. **F** (Custom LLM) — self-contained, can be done in parallel with A.
8. **H** (Request Logging) — smallest scope, no dependencies.
9. **I** (Tests) — ongoing, but a dedicated pass after all stubs are ported.
