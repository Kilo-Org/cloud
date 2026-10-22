# Direct BYOK: optional unified catalog model IDs

**Date**: 2026-10-21 (updated 2026-10-22 after review)
**Status**: Plan, not implemented
**Scope**: Use models.dev to map direct BYOK models to main catalog (OpenRouter-style) model IDs. Users can opt in per BYOK key to serving catalog IDs with that key. Bespoke IDs keep working. Providers not in models.dev are out of scope.

## Problem

`formatDirectByokModelId` (`packages/web-shared/src/lib/ai-gateway/providers/direct-byok/index.ts:32`) builds every direct BYOK ID as `(<provider>/<upstream id>).toLowerCase()`. As a result, one model is listed under many unrelated IDs. None of them matches the catalog:

| Catalog ID | Direct BYOK IDs for the same model |
|---|---|
| `moonshotai/kimi-k2.6` | `synthetic/hf:moonshotai/kimi-k2.6`, `chutes-byok/moonshotai/kimi-k2.6-tee`, `ollama-cloud/kimi-k2.6:cloud`, `orcarouter/kimi/kimi-k2.6`, `inceptron-byok/moonshotai/kimi-k2.6`, `opencode-go/kimi-k2.6`, … |
| `z-ai/glm-5.2` | `zai-coding/glm-5.2`, `synthetic/hf:zai-org/glm-5.2`, … |

Consequences:

- **Model pickers** show several near-duplicate entries per model.
- **Switching to your own key means switching models.** A user cannot keep selecting `moonshotai/kimi-k2.6` and have it billed to their own key. Vercel BYOK already works that way for first-party providers.
- **No access to catalog data.** Catalog metadata (`model_stats`, benchmarks, display data) is out of reach. For example, auto routing gives these models placeholder capabilities (`services/auto-routing/src/custom-router-decision.ts:119-155`).
- **Organization model policies do not apply.** Direct BYOK models are exempt (`isModelRestrictionExempt`, `packages/web-shared/src/lib/model-allow.server.ts:51`).

## Data source: models.dev only

The data comes from two parts of models.dev's `https://models.dev/api.json`, which the direct BYOK sync already fetches (`apps/web/src/lib/providers/direct-byok/sync-direct-byok.ts`):

1. **`canonical_model_id` on provider models.** It is present on about 85% of models.dev entries, e.g. `synthetic` `hf:moonshotai/Kimi-K2.6` → `moonshotai/kimi-k2.6`, `ollama-cloud` `gemma4:31b` → `google/gemma-4-31b-it`.
   - The values use models.dev's own vendor namespace (`zhipuai/`, `alibaba/`, `xai/`, `mistral/`, dashed Anthropic versions), not OpenRouter's.
2. **The models.dev `openrouter` provider.** Its entries are keyed by OpenRouter IDs and also carry `canonical_model_id`. Reversing them gives a `canonical → OpenRouter ID` index.
   - This replaces any hand-maintained vendor rename table (`zhipuai`→`z-ai`, `alibaba`→`qwen`, …).

Explicitly **not** used for now:
- OpenRouter `hugging_face_id`;
- exact or partial name matching;
- per-model mapping functions;
- admin override tables.

These can be revisited if coverage turns out to be insufficient.

### Provider scope

Each `DirectByokProvider` gets an optional `models_dev_id` (`direct-byok/types.ts`). Only providers that set it take part.

| Provider | `models_dev_id` |
|---|---|
| alibaba-token-plan | `alibaba-token-plan` |
| chutes-byok | `chutes` |
| edenai | `edenai` |
| inceptron-byok | `inceptron` |
| morph-byok | `morph` |
| neuralwatt | `neuralwatt` |
| nvidia-byok | `nvidia` |
| ollama-cloud | `ollama-cloud` |
| opencode-go | `opencode-go` |
| orcarouter | `orcarouter` |
| synthetic | `synthetic` |
| xiaomi-token-plan-ams / -sgp | `xiaomi-token-plan-ams` / `-sgp` |
| zai-coding | `zai-coding-plan` |
| martian, byteplus-coding | not in models.dev; excluded |
| kimi-coding | unset. Its single static model `kimi-for-coding` is a moving alias for whatever model the plan currently serves. |

The `models_dev_id` replaces the catalog key that is hard-coded in `FETCHERS` today, so the sync and the mapping share one source. Providers whose model list comes from their own OpenAI-compatible `/models` endpoint still list models that way. They only use models.dev to look up `canonical_model_id`. Upstream models missing from models.dev stay unmapped.

### Coverage snapshot (2026-10-21)

These numbers came from live models.dev, live OpenRouter `/models` and each provider's live model list. Lists were filtered to the models.dev subset where the sync does the same.

| Provider | Mapped / total | Not in models.dev |
|---|---|---|
| zai-coding | 7/7 | 0 |
| inceptron-byok | 6/6 | 0 |
| ollama-cloud | 21/22 | 0 |
| chutes-byok | 13/14 | 0 |
| opencode-go | 27/29 | 0 |
| edenai | 308/359 | 0 |
| neuralwatt | 20/27 | 7 |
| alibaba-token-plan | 19/29 | 0 |
| nvidia-byok | 16/26 | 0 |
| synthetic | 8/14 | 6 |
| orcarouter | 97/209 | 95 |
| xiaomi-token-plan-ams / -sgp | 4/9 each | 0 |
| morph-byok | 0/11 | 9 |
| **Total** | **550/771 (71%)** | 117 |

**What maps and what doesn't:**
- The coding models (Kimi, GLM, Qwen, DeepSeek, MiniMax, MiMo, gpt-oss, Gemma) map on every provider that serves them.
- Most other misses are models OpenRouter does not list: provider routers, fine-tunes, TTS, image and video models.
- OrcaRouter's 95 models missing from models.dev mostly already use OpenRouter-style IDs. A later exact-ID step could pick them up.

## Design

### Resolver

A pure function, unit-tested with small fixture slices of the models.dev catalog:

```ts
resolveCatalogModelId(
  upstreamId: string,
  modelsDevProvider: ModelsDevProvider,
  index: CatalogIndex
): string | null
```

`CatalogIndex` is built once per sync from two inputs:
- the set of current catalog IDs, excluding `:variant` IDs such as `:free`;
- `canonical → catalog ID` from the models.dev `openrouter` provider. When several catalog IDs share a canonical ID, prefer the one equal to the canonical ID, then the shortest. This avoids dated snapshots.

Resolution steps:
1. Look up `modelsDevProvider.models[upstreamId].canonical_model_id`. If it is missing, return `null`.
2. If the canonical ID is itself a catalog ID, return it.
3. Otherwise return `index.canonicalToCatalog.get(canonical) ?? null`.

**Prerequisite: parse `canonical_model_id`.** Zod's default object parsing drops undeclared keys, and today's `ModelsDevModelSchema` (`apps/web/src/lib/providers/direct-byok/sync-direct-byok.ts:33`) does not declare `canonical_model_id`. Without a change, every model parsed through `ModelsDevProviderSchema` loses the field and the resolver returns `null` for all of them. Add `canonical_model_id: z.string().optional().catch(undefined)` to that schema. Parse the models.dev `openrouter` entry with the same schema when building the index. That entry is otherwise untouched, because `ModelsDevCatalogSchema` keeps provider entries as `unknown`.

### Storage (no migration for model data)

Extend `DirectByokModelSchema` (`packages/db/src/schema-types.ts`) with `catalog_model_id: z.string().optional()`. It is stored in the existing `direct_byok_model_lists.models` jsonb.

The sync builds the index from the models.dev catalog it already fetches once per run, plus the OpenRouter snapshot that `syncAndStoreProviders` has just fetched (pass it through `SyncContext`). It annotates every synced model and logs the mapped count per provider.

### Read-time merge and primary selection

**The merge with static recommended models.** `cachedEnhancedDirectByokModelList` (`packages/web-shared/src/lib/ai-gateway/providers/direct-byok/model-list.ts:46-61`) works like this today:
- it puts each provider's static `recommendedModels` ahead of the synced rows;
- for a model in both lists, it keeps the static entry;
- it copies only `reasoning_options` over from the synced entry;
- the `recommended` flag exists only at this point; the sync never sees it.

Two changes follow from that:

1. **Copy the catalog ID.** `enhanceDirectByokModelList` copies `catalog_model_id` from the synced entry with the same upstream ID, exactly as it does for `reasoning_options`. A static recommended model that is missing from the synced list stays unmapped. Such a model is not on the provider's live list, so serving it under a catalog ID would be a guess.
2. **Select the primary here.** Primary selection happens in this read step, not in the sync, so the `recommended` flag can take part. Several upstream models from one provider can map to the same catalog ID. For example:
   - neuralwatt's `kimi-k3`, `kimi-k3-fast` and `kimi-k3-flex` all map to `moonshotai/kimi-k3`;
   - zai-coding's `glm-5.3` and `glm-5.3-highspeed` both map to `z-ai/glm-5.3`.

   Exactly one is chosen as the **primary** for each catalog ID, in this order:
   1. the model whose upstream ID, lowercased and without an `hf:` prefix, ends with the catalog ID's last path segment;
   2. then the model flagged `recommended`;
   3. then the shortest upstream ID.

   The result can be a derived `Map<catalogId, upstreamId>` cached next to the list. It is not stored. Only the primary is served under the catalog ID; the other variants remain reachable through their bespoke IDs.

A mapping only counts as live if the catalog ID is still valid (`isValidOpenRouterModelId`), because the catalog can drift between syncs.

### Opt-in: per key

Add `byok_api_keys.serve_catalog_models boolean not null default false`. This needs a migration; follow the `database-migrations` skill.
- **Web UI.** Add a switch per direct BYOK key in `BYOKKeysManager.tsx`, labelled "Use this key for matching Kilo catalog models". Show it only for providers with a `models_dev_id`.
- **Who may change the flag on organization keys.** Owners and admins only (`ORGANIZATION_MANAGE_ROLES`), the same roles that can edit model and provider policies (`organizationAdminMutationProcedure`). Org BYOK keys themselves can also be managed by billing managers (`ORGANIZATION_BILLING_ROLES` in `byok-router.ts`). If billing managers could set this flag too, they could send catalog traffic to an upstream that policy admins never approved. See [Model policy enforcement](#model-policy-enforcement).
- **Key data.** Expose the flag in `byok-router.ts` list and update procedures. Return it from `getBYOKforUser` / `getBYOKforOrganization` and from `getUserByokProviderIds` / `getOrganizationByokProviderIds`, or from a sibling helper.

With the flag off, behavior is exactly as today.

### Behavior when a key is opted in

#### Model list (`handlers/models.ts`, `organizations/organization-models.ts`)

- **Badge on catalog models.** A catalog model with a live, primary mapping on an opted-in, enabled key gets `hasUserByokAvailable: true`. Extend `addUserByokAvailability` (`packages/web-shared/src/lib/ai-gateway/byok/index.ts:80`) to check direct mappings as well as Vercel endpoints.
- **Hidden bespoke entries.** For opted-in providers, every bespoke entry with a live `catalog_model_id` is left out of the list: primary models and their variants alike. Bespoke entries without a mapping stay listed, unchanged.
- **Hidden IDs keep working.** `/models/validate` (`handlers/model-validation.ts`) and the favorites and last-selected filters (`apps/web/src/routers/model-preferences-router.ts`) check against the list of available IDs. They must also accept hidden bespoke IDs so that stored references keep working. Favorites are not rewritten.

#### Routing (`providers/get-provider.ts`)

The easiest place is the existing `checkDirectBYOK`, which already runs before the ChatGPT subscription and Vercel BYOK checks. **Direct BYOK therefore wins over both**; that is acceptable for now.

1. **Bespoke ID.** Behaves as today: `getDirectByokModel` matches the prefix and the exact ID.
2. **Catalog ID (new).** If no bespoke ID matched:
   - find the primary direct BYOK model whose `catalog_model_id` equals the requested ID, among the user's or organization's enabled keys that have `serve_catalog_models`;
   - if several providers qualify, take the first one in `DIRECT_BYOK_PROVIDERS` order;
   - set `body.model` to that model's upstream ID and run the provider's `transformRequest`, the same path bespoke IDs use.
3. **No match.** Fall through to the existing routes, so the request goes to the Kilo-paid path as today.
4. **Failures.** An upstream BYOK error is returned to the caller and does not silently fall back to Kilo credits, the same as existing BYOK.

#### Model policy enforcement

When a request is served by an opted-in key, organization model policies apply:
- **Return value.** `checkDirectBYOK` returns `bypassAccessCheck: false` for these requests, with `userByok` set. A set `userByok` already skips the zero-balance block (`llm-proxy.ts:901-905`). Vercel BYOK already returns this shape (`get-provider.ts`, `checkVercelBYOK` branch). ChatGPT BYOK does not: it returns `userByok: null` with `skipBalanceCheck: true`, so it is not the model to copy.
- **Which ID is checked.** The access check uses the catalog ID. For a catalog ID request that is the requested ID. For a bespoke ID with a live mapping on an opted-in key, it is that model's `catalog_model_id`, so the bespoke ID cannot be used to get around a deny rule. `createAccessCheckResolver` (`llm-proxy.ts:808`) needs to receive this policy model ID instead of the raw requested ID.
- **Unmapped bespoke IDs** keep today's exemption, because no catalog entry exists that an admin could allow or deny.
- **Provider allowlists do not cover direct BYOK upstreams.** Organization provider allowlists list OpenRouter and Vercel provider slugs. Direct BYOK providers are deliberately kept out of the provider policy UI (`handlers/providers.ts`, `withDirectByokProviders`), so an admin can neither allow nor exclude them there.
  - **What is checked instead.** For catalog-ID routing, the allowlist still decides whether the catalog **model** is allowed (`groupModelAllowed` / `groupProvidersAllowed`, evaluated as for a Kilo-routed request). Which upstream serves the request is authorized by the opt-in on the key, and only owners and admins can set that opt-in on organization keys (see [Opt-in: per key](#opt-in-per-key)).
  - **Routing output is ignored.** The resulting `effectiveProviderConfig.only` has no meaning for a direct BYOK upstream and is already dropped, because direct BYOK `transformRequest` deletes `body.provider`.
  - **Rejected alternative.** "Only route if the direct BYOK provider is on the allowlist" would turn the feature off for every organization that has a provider allowlist, because no allowlist can contain a direct BYOK provider today.
  - **Later option.** If admins need per-provider control, add direct BYOK providers to the provider policy UI as its own change, then gate on them.
  - **Personal requests** have no organization policy, so none of this applies to them.
- **Model list.** `isModelRestrictionExempt` (`model-allow.server.ts:51`) stays as it is, because hidden bespoke entries are no longer in the list.

#### Usage and leaderboards (easiest path)

No changes:
- `requested_model` is the catalog ID for catalog requests and stays the bespoke ID for bespoke requests;
- `provider` stays `'direct-byok'`;
- `leaderboard-model-provider-usage` already excludes `direct-byok`;
- `leaderboard-model-usage` groups by requested model, so traffic routed by catalog ID counts toward that catalog model.

### Deferred

- Showing `catalog_model_id` on bespoke `/models` entries, and using it for model-family heuristics, `model_stats` and benchmarks.
- Exact-ID and `hugging_face_id` fallbacks for models that are not in models.dev, and admin overrides.
- A user-defined order of preference between providers, and a precedence choice between Vercel and direct BYOK.
- Renaming bespoke IDs.

## Implementation steps

1. Add `models_dev_id` to the provider definitions and drive the models.dev fetchers from it.
2. Add `canonical_model_id` to `ModelsDevModelSchema`, then add the resolver with fixture-based unit tests. The fixtures must include the raw models.dev shape, so a schema that strips the field fails the test.
3. Annotate models during the sync, extend `DirectByokModelSchema` with `catalog_model_id`, and log coverage. Extend `sync-direct-byok.test.ts`.
4. Copy `catalog_model_id` in `enhanceDirectByokModelList` and select the primary there. Extend `model-list.test.ts` with recommended models (catalog ID copied, recommended model wins the tie-break).
5. Migrate `byok_api_keys.serve_catalog_models`, then update the BYOK router (owner/admin-only for organization keys) and the web UI switch.
6. Model list: set the badge, hide mapped bespoke entries, and accept hidden IDs in validation and model preferences. Extend `handlers/models.test.ts`, `organization-models.test.ts`, `model-validation.test.ts` and the model preferences tests.
7. Routing and policy: resolve catalog IDs in `checkDirectBYOK`, set `bypassAccessCheck: false` for opted-in keys, and run the access check against the catalog ID. Extend the `get-provider` tests and the llm-proxy access-check tests for both allow and deny, for catalog and bespoke IDs.

## Open questions

1. **Kilo CLI and hidden IDs.** Does the Kilo CLI cache or validate model IDs against `/models` in a way that breaks when bespoke IDs disappear from the list?
2. **Spec.** Should this become a `.specs/` business-rule document once implementation starts?
