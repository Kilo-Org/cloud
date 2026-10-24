# Direct BYOK: optional unified catalog model IDs

**Date**: 2026-10-21 (updated 2026-10-23)
**Status**: Plan, not implemented
**Scope**: Use models.dev to map direct BYOK models to main catalog (OpenRouter-style) model IDs. A per-key catalog mode makes that key serve catalog IDs only, with organization model policies enforced; bespoke IDs for that key stop working. Providers not in models.dev are out of scope.

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

   The result can be a derived `Map<catalogId, upstreamId>` cached next to the list. It is not stored. Only the primary is served under the catalog ID. The other variants are reachable only through their bespoke IDs, and only while catalog mode is off.

A mapping only counts as live if the catalog ID is still valid (`isValidOpenRouterModelId`), because the catalog can drift between syncs.

### Catalog mode: per key

Add `byok_api_keys.serve_catalog_models`, called **catalog mode** below. One key exists per provider per owner (`UQ_byok_api_keys_user_provider` / `UQ_byok_api_keys_org_provider`), so catalog mode is effectively a setting per provider per owner.

When catalog mode is on, the key serves **only** catalog IDs. Every bespoke ID for that provider stops working. Mapped and unmapped IDs, primaries and variants are all treated the same. Turned off, the behavior is exactly as today.

**Why reject bespoke IDs instead of translating them.** A mapped bespoke ID could be served after checking policy against its `catalog_model_id`. That would close the policy bypass just as well. Rejecting is preferred anyway:
- **One ID per model.** Each model has a single ID, there is one routing path, and no exemption is left that someone has to remember.
- **Unmapped IDs.** These are routers, fine-tunes and models that OpenRouter does not list. They have no catalog entry that a policy could allow or deny. Keeping them would preserve exactly the bypass this mode exists to remove.

**The cost.** While catalog mode is on, unmapped models and serving-tier variants (`-flex`, `-fast`, `-highspeed`) are unreachable through that key. Users who need them leave catalog mode off.

#### Default

Recommendation: **on by default for new keys of supported providers** (providers with a `models_dev_id`). Existing keys are backfilled **off**.

- **New keys default on:**
  - It is the safer default for organizations. Model policies apply, and the key no longer silently bypasses them.
  - It is the better default for users. Pickers show one entry per model, with the BYOK badge, instead of a second, parallel set of models.
- **Existing keys stay off.** Turning catalog mode on for them would silently break:
  - stored favorites and last-selected models;
  - organization Auto targets and custom-router entries;
  - CLI configs that use bespoke IDs.
- **Prompting existing owners.** The BYOK page shows existing owners an "Enable catalog mode" prompt instead.
- **Migration.** One migration does both: it adds the column with `default false` and leaves existing rows false, then sets the column default to `true`. The application only sends `true` on insert for providers with a `models_dev_id`; unsupported providers always store `false`.

#### Permissions

| Key owner | Who can turn it on | Who can turn it off |
|---|---|---|
| Personal key | The key owner | The key owner |
| Organization key | Owner or admin (`ORGANIZATION_MANAGE_ROLES`) | Owner or admin (`ORGANIZATION_MANAGE_ROLES`) |

**Turning it off is the sensitive direction.** It restores the policy bypass for that provider, so it needs the same roles that edit model policies (`organizationAdminMutationProcedure`).

**Turning it on also needs owner or admin:**
- It sends the organization's catalog traffic to a new upstream.
- It breaks members' stored bespoke references, as described in [Stored references](#stored-references).

**Billing managers.** They can create and manage organization BYOK keys today (`ORGANIZATION_BILLING_ROLES` in `byok-router.ts`). A new key they create gets the default and so starts in catalog mode, but they cannot change the flag afterwards.

**The default-on egress question.** A billing manager's new key in catalog mode routes catalog models to that provider without a separate admin approval. This is still narrower than today: the same billing manager can already add a key whose bespoke models bypass every policy. If organizations need admin approval for any new upstream, the fix is to restrict direct BYOK key creation to owners and admins. That is a separate change and is listed under [Deferred](#deferred).

**Web UI.** `BYOKKeysManager.tsx` gets a switch per direct BYOK key, labelled "Use Kilo catalog model IDs (required for model policies)". It is shown only for supported providers, and it is read-only for billing managers.

**Key data.** Expose the flag in `byok-router.ts` list, create and update. Return it from `getBYOKforUser` / `getBYOKforOrganization` and from `getUserByokProviderIds` / `getOrganizationByokProviderIds`, or from a sibling helper.

### Behavior when catalog mode is on

#### Model list (`handlers/models.ts`, `organizations/organization-models.ts`)

- **Badge on catalog models.** A catalog model with a live, primary mapping on a catalog-mode key gets `hasUserByokAvailable: true`. Extend `addUserByokAvailability` (`packages/web-shared/src/lib/ai-gateway/byok/index.ts:80`) to check direct mappings as well as Vercel endpoints.
- **No bespoke entries.** None are listed for that provider, mapped or unmapped.
- **Validation rejects them.** `/models/validate` (`handlers/model-validation.ts`) rejects bespoke IDs for that provider.

#### Routing (`providers/get-provider.ts`)

The easiest place is the existing `checkDirectBYOK`, which already runs before the ChatGPT subscription and Vercel BYOK checks. **Direct BYOK therefore wins over both**; that is acceptable for now.

1. **Bespoke ID, key in catalog mode.**
   - Return a new result kind, `{ kind: 'direct-byok-catalog-only', catalogModelId?: string }`, and handle it next to `custom-llm-unavailable` in `llm-proxy.ts`.
   - The response explains that the model ID is disabled because the provider key uses Kilo catalog IDs. When a mapping exists, it names the catalog ID to use instead.
   - The request must not fall through to the OpenRouter route, which would fail later with a misleading "model does not exist" error. This follows the root `AGENTS.md` failure UX: fail fast, with a specific reason.
2. **Bespoke ID, key not in catalog mode.** Behaves as today.
3. **Catalog ID.**
   - Find the primary direct BYOK model whose `catalog_model_id` equals the requested ID, among the user's or organization's enabled catalog-mode keys.
   - If several providers qualify, take the first one in `DIRECT_BYOK_PROVIDERS` order.
   - Set `body.model` to that model's upstream ID and run the provider's `transformRequest`.
4. **No match.** Fall through to the existing routes, so the request goes to the Kilo-paid path as today.
5. **Failures.** An upstream BYOK error is returned to the caller and does not silently fall back to Kilo credits, the same as existing BYOK.

#### Model policy enforcement

Every request served by a catalog-mode key uses a catalog ID, so organization model policies apply without exceptions:
- **Return value.** `checkDirectBYOK` returns `bypassAccessCheck: false` with `userByok` set, the same shape Vercel BYOK uses (`get-provider.ts`, `checkVercelBYOK` branch). A set `userByok` already skips the zero-balance block (`llm-proxy.ts:901-905`). ChatGPT BYOK uses a different shape: `userByok: null` with `skipBalanceCheck: true`.
- **Which ID is checked.** The access check runs on the requested ID, which is the catalog ID. `createAccessCheckResolver` (`llm-proxy.ts:808`) needs no special policy-ID plumbing.
- **Keys not in catalog mode** keep today's exemption (`isModelRestrictionExempt`, `model-allow.server.ts:51`). That exemption is the reason default-on matters for organizations.
- **Provider allowlists do not cover direct BYOK upstreams.** Organization provider allowlists list OpenRouter and Vercel provider slugs. Direct BYOK providers are deliberately kept out of the provider policy UI (`handlers/providers.ts`, `withDirectByokProviders`), so an admin can neither allow nor exclude them there.
  - **What is checked instead.** The allowlist still decides whether the catalog **model** is allowed (`groupModelAllowed` / `groupProvidersAllowed`, evaluated as for a Kilo-routed request). Which upstream serves the request is governed by the key and its catalog mode, with the permissions above.
  - **Routing output is ignored.** The resulting `effectiveProviderConfig.only` has no meaning for a direct BYOK upstream and is already dropped, because direct BYOK `transformRequest` deletes `body.provider`.
  - **Rejected alternative.** "Only route if the direct BYOK provider is on the allowlist" would turn the feature off for every organization that has a provider allowlist, because no allowlist can contain a direct BYOK provider today.
  - **Personal requests** have no organization policy.

#### Stored references

When catalog mode is turned on for an existing key, the stored bespoke IDs for that provider stop resolving:

- **Favorites and last-selected model** (`user_model_preferences`, `apps/web/src/routers/model-preferences-router.ts`).
  - When reading, translate mapped bespoke IDs to their catalog ID and drop unmapped ones.
  - Nothing is written back, so turning catalog mode off later restores the originals.
- **Organization Auto target and organization custom routers** (`organization-auto-model.ts`, ADR 0005).
  - The `setCatalogMode` mutation for organization keys rewrites mapped bespoke references to catalog IDs in the same transaction. Because this is an explicit admin action, it is audit-logged.
  - It returns the unmapped references, and the UI lists them before the admin confirms.
  - After the switch, unmapped references fail at request time with the existing, specific org Auto configuration error (`llm-proxy.ts`, `organizationAutoConfigurationResponse`), extended with the catalog-mode reason.
- **CLI and extension configs** that name a bespoke ID get the fail-fast error above, which names the catalog ID to switch to.

New keys that start in catalog mode have no stored references yet.

#### Usage and leaderboards (easiest path)

No changes:
- `requested_model` is the catalog ID;
- `provider` stays `'direct-byok'`;
- `leaderboard-model-provider-usage` already excludes `direct-byok`;
- `leaderboard-model-usage` groups by requested model, so catalog-mode traffic counts toward that catalog model.

### Deferred

- Showing `catalog_model_id` on bespoke `/models` entries when catalog mode is off, and using it for model-family heuristics, `model_stats` and benchmarks.
- Exact-ID and `hugging_face_id` fallbacks for models that are not in models.dev, and admin overrides.
- A user-defined order of preference between providers, and a precedence choice between Vercel and direct BYOK.
- Restricting creation of organization direct BYOK keys to owners and admins, if organizations need admin approval for every new upstream.
- Adding direct BYOK providers to the provider policy UI, for per-provider allow and deny.
- Renaming bespoke IDs.

## Implementation steps

1. Add `models_dev_id` to the provider definitions and drive the models.dev fetchers from it.
2. Add `canonical_model_id` to `ModelsDevModelSchema`, then add the resolver with fixture-based unit tests. The fixtures must include the raw models.dev shape, so a schema that strips the field fails the test.
3. Annotate models during the sync, extend `DirectByokModelSchema` with `catalog_model_id`, and log coverage. Extend `sync-direct-byok.test.ts`.
4. Copy `catalog_model_id` in `enhanceDirectByokModelList` and select the primary there. Extend `model-list.test.ts` with recommended models (catalog ID copied, recommended model wins the tie-break).
5. Migration for `byok_api_keys.serve_catalog_models`: existing rows false, new rows default true, and only supported providers may store true.
6. BYOK router:
   - catalog-mode flag on create and update, owner/admin-only to change on organization keys;
   - the organization `setCatalogMode` mutation, with reference rewriting and an audit log;
   - the web UI switch and the "Enable catalog mode" prompt for existing keys.
7. Model list: set the badge, hide bespoke entries for catalog-mode providers, and reject them in validation. Extend `handlers/models.test.ts`, `organization-models.test.ts` and `model-validation.test.ts`.
8. Routing and policy:
   - resolve catalog IDs in `checkDirectBYOK`;
   - reject bespoke IDs with `direct-byok-catalog-only`;
   - return `bypassAccessCheck: false` for catalog-mode keys.

   Extend the `get-provider` tests and the llm-proxy tests for allowed and denied catalog IDs, and for rejected bespoke IDs with and without a mapping.
9. Translate stored references in model preferences, and extend the error message for organization Auto. Extend the model preferences tests and `organization-auto-model` tests.

## Open questions

1. **Kilo CLI defaults.** Does the Kilo CLI fall back gracefully when a configured default model ID starts returning an error? Or does catalog mode need a release note for CLI users who set a bespoke ID?
2. **Spec.** Should this become a `.specs/` business-rule document once implementation starts?
