# Direct BYOK: optional unified catalog model IDs

**Date**: 2026-10-21
**Status**: Plan, not implemented
**Scope**: Map direct BYOK models to main catalog (OpenRouter-style) model IDs. First expose the mapping as metadata. Then let users opt in to sending catalog IDs through their own direct BYOK keys. Bespoke IDs keep working.

## Problem

`formatDirectByokModelId` (`packages/web-shared/src/lib/ai-gateway/providers/direct-byok/index.ts:32`) builds every direct BYOK ID as `(<provider>/<upstream id>).toLowerCase()`. As a result, one model is listed under many unrelated IDs. None of them matches the catalog:

| Catalog ID | Direct BYOK IDs for the same model |
|---|---|
| `moonshotai/kimi-k2.6` | `synthetic/hf:moonshotai/kimi-k2.6`, `chutes-byok/moonshotai/kimi-k2.6-tee`, `ollama-cloud/kimi-k2.6:cloud`, `orcarouter/kimi/kimi-k2.6`, `inceptron-byok/moonshotai/kimi-k2.6`, `opencode-go/kimi-k2.6`, … |
| `z-ai/glm-5.2` | `zai-coding/glm-5.2`, `byteplus-coding/glm-5.2`, `synthetic/hf:zai-org/glm-5.2`, … |

Consequences:

- **Model pickers** show several near-duplicate entries per model. They also have no link to the catalog entry, so catalog benchmarks, descriptions and display pricing are missing.
- **Auto routing and custom routers** give direct BYOK models placeholder capabilities because they have no `model_stats` row (`services/auto-routing/src/custom-router-decision.ts:119-155`).
- **Model-family logic** (`isKimiModel`, `getFallbackReasoningOptions`, `getAiSdkProvider`, …) relies on substring checks over the bespoke ID. It only works because upstream names usually contain the family name.
- **Users must choose a different model to switch billing paths.** They cannot keep selecting `moonshotai/kimi-k2.6` and have it billed to their own key. Vercel BYOK already works this way for first-party providers (same catalog ID, the user's key is used).
- **`canonical_slug` carries no information.** It is emitted on direct BYOK models but is set to the bespoke ID itself (`direct-byok/index.ts:45`).

## Data sources investigated

| Source | What it offers | Verdict |
|---|---|---|
| **models.dev `canonical_model_id`** | Present on about 85% of all models.dev entries, e.g. `synthetic` `hf:moonshotai/Kimi-K2.6` → `moonshotai/kimi-k2.6`, `ollama-cloud` `gemma4:31b` → `google/gemma-4-31b-it`. It uses models.dev's own vendor namespace (`zhipuai/`, `alibaba/`, `xai/`, `mistral/`, and dashes for Anthropic), not OpenRouter's. | **Primary signal.** |
| **models.dev `openrouter` provider** | Its entries are keyed by OpenRouter IDs and also carry `canonical_model_id`. Reversing them gives a `canonical → OpenRouter id` index. This removes the need for a hand-maintained vendor rename table (`zhipuai`→`z-ai`, `alibaba`→`qwen`, …). | **Primary signal**, used to join the step above. |
| OpenRouter `/models` `hugging_face_id` | Present for open-weight models; joins HF-style upstream IDs (Chutes, Inceptron, Synthetic). Our schema currently strips it (`OpenRouterModelsResponseSchema`). | Cheap fallback for providers that are not in models.dev. |
| OpenRouter `canonical_slug` | A dated permaslug (`deepseek/deepseek-v4.1-flash-20261017`), not a cross-provider key. | Not useful. |
| models.dev `family` | Coarse (`kimi-k2`, `glm-flash`). | Not precise enough for IDs; could replace some substring family heuristics later. |
| Per-provider mapping functions | Needed only for systematic spelling differences, e.g. the `hf:` prefix, the `-TEE` suffix or Ollama `name:tag`. | Small optional per-provider hook; no long lists. |

Every provider we sync is in models.dev, even the ones whose list we take from their OpenAI-compatible `/models` endpoint (`chutes`, `inceptron`, `neuralwatt`, `synthetic`, `orcarouter`, `morph`). The exceptions are `martian`, `byteplus-coding` (static list) and `kimi-coding` (static, one model). Martian already uses OpenRouter IDs verbatim.

## Feasibility snapshot (2026-10-21)

The resolver below was run against live models.dev, live OpenRouter `/models` and each provider's live model list. For models.dev-backed providers the list was cut down to the models.dev subset, as the sync does.

| Provider | Mapped / total | Main method |
|---|---|---|
| zai-coding | 7/7 | models.dev |
| inceptron-byok | 6/6 | models.dev |
| ollama-cloud | 21/22 | models.dev |
| chutes-byok | 13/14 | models.dev |
| opencode-go | 27/30 | models.dev |
| edenai | 306/357 | models.dev |
| martian | 256/316 | exact ID |
| neuralwatt | 20/27 | models.dev |
| alibaba-token-plan | 20/29 | models.dev |
| nvidia-byok | 16/26 | models.dev |
| orcarouter | 119/209 | models.dev and exact ID |
| synthetic | 9/14 | models.dev |
| xiaomi-token-plan-ams/sgp | 4/9 each | models.dev |
| kimi-coding (models.dev `kimi-code-plan-global`) | 2/4 | models.dev; the 2 misses are moving aliases |
| morph-byok | 2/11 | tail match |
| **Total** (one Xiaomi region counted) | **828/1081 (77%)** | |

`byteplus-coding` is not in the snapshot because its list is static and it has no models.dev entry. It would depend on the `exact` and `heuristic` steps or on overrides.

The unmapped models are almost all models with **no catalog counterpart**:
- provider routers (`orcarouter/fusion`, `nw-large`, `syn:large:text`);
- fine-tunes (`morph-glm53-744b`);
- TTS, image and video models (`mimo-v2.5-tts`, `wan2.7-image`);
- models OpenRouter does not list (`qwen3.8-max`, older NVIDIA NIM models).

The models that matter for coding (Kimi, GLM, Qwen, DeepSeek, MiniMax, MiMo, gpt-oss, Gemma) map on every provider that serves them.

Precision issues found in the snapshot. The resolver design below handles all of them:

1. **Free variants in the reverse index.** It contained `:free` variants (`minimax-m3.1-flash` → `minimax/minimax-m3.1-flash:free`). Variant IDs must be excluded from the index.
2. **Router namespaces in tail matching.** A bare tail match gave `orcarouter/free` → `openrouter/free`. A tail match must also require the vendor to match.
3. **Serving-tier variants collapse onto one catalog ID.** For example, `neuralwatt` `kimi-k3`, `kimi-k3-fast` and `kimi-k3-flex` all map to `moonshotai/kimi-k3`, and Chutes `gemma-4-31B-turbo-TEE` maps to `google/gemma-4-31b-it`. That is correct for metadata, but routing needs one deterministic winner per provider.
4. **Moving aliases.** models.dev maps `kimi-for-coding` to whatever model the plan currently serves. Such entries must never be used for routing.
5. **Dated snapshots.** `deepseek-v4.1-flash` resolved to `deepseek-v4.1-flash` on one provider and `deepseek-v4.1-flash-1017` on another. The tie-break should prefer exact canonical equality, then the shorter ID.

## Design

### Resolver (pure function, unit-tested with fixture slices)

```ts
type CatalogMatch = 'override' | 'exact' | 'models-dev' | 'heuristic';

resolveCatalogModelId(input: {
  upstreamId: string;
  modelsDevEntry?: ModelsDevModel;        // provider's models.dev entry, if any
  normalize?: (upstreamId: string) => string; // optional per-provider hook
}, index: CatalogIndex): { id: string; match: CatalogMatch } | null
```

`CatalogIndex` is built once per sync. It holds:
- the set of catalog IDs, with no `:variant` IDs;
- a lowercase-ID lookup;
- `canonical → catalog id`, built from the models.dev `openrouter` provider;
- `hugging_face_id → catalog id`;
- a unique `tail → catalog id` map.

The resolver tries these steps in order:

1. **Admin override**, `null` included, to suppress a bad match.
2. **`exact`.** The normalized upstream ID equals a catalog ID (Martian, OrcaRouter, EdenAI pass-through).
3. **`models-dev`.** `canonical_model_id` resolves through the reverse index, or equals a catalog ID directly.
4. **`exact` via `hugging_face_id`.** The normalized upstream ID equals a catalog `hugging_face_id`.
5. **`heuristic`.** A unique tail match, with the vendor required to match when the upstream ID has one.

The default normalizer strips `hf:` and lowercases. Per-provider hooks stay one-liners, such as Chutes `-TEE` or Ollama `name:tag` → `name-tag`.

A match is marked **routable** when its method is `override`, `exact` or `models-dev`, and the provider is not flagged as serving moving aliases. A flag on the provider definition is enough, e.g. `catalog_aliases: false` for `kimi-coding`. `heuristic` matches are metadata only.

### Phase 1: compute, store and expose the mapping (no routing change)

1. **Model schema.** Add two optional fields to `DirectByokModelSchema` (`packages/db/src/schema-types.ts`): `catalog_model_id: z.string().optional()` and `catalog_match: CatalogMatchSchema.optional()`. The data lives in the `direct_byok_model_lists.models` jsonb, so no migration is needed.
2. **Provider definitions.** Add an optional `models_dev_key` and an optional `normalizeCatalogId` hook to `DirectByokProvider` (`direct-byok/types.ts`). Move the models.dev key out of the `FETCHERS` table so providers listed via OpenAI-compatible endpoints can also use models.dev metadata.
3. **Sync.** In `apps/web/src/lib/providers/direct-byok/sync-direct-byok.ts`, build `CatalogIndex` from the OpenRouter snapshot that `syncAndStoreProviders` has already fetched (pass it through `SyncContext`) and from the models.dev catalog that is already fetched once per run. Annotate every model, then log per-provider coverage counts to Axiom so drift is visible.
4. **Overrides.** Add `ai_gateway_config.direct_byok_catalog_overrides: Record<bespokeId, catalogId | null>` and copy the pattern of `vercel_model_id_overrides` and its admin router. This is the only hand-maintained data, expected to hold a handful of entries.
5. **Read path.** In `convertModel` (`direct-byok/index.ts:36`), emit `catalog_model_id` on direct BYOK `/models` entries, but only if the ID is still in the current catalog (`isValidOpenRouterModelId`), because the catalog drifts between syncs. Keep `canonical_slug` unchanged until the Kilo CLI's use of it is checked (see open questions).
6. **Use the link internally:**
   - Fall back to the catalog entry's `opencode` settings (family, reasoning options) when models.dev gave none.
   - Run model-family checks against `catalog_model_id ?? id`.
   - Let auto routing and custom routers look up `model_stats` and benchmarks through `catalog_model_id`, instead of using placeholder capabilities.
7. **Clients (optional, additive).** The web, extension and mobile pickers can group direct BYOK entries under their catalog model.

Phase 1 is additive and safe to ship without a flag.

### Phase 2: opt-in unified IDs (catalog ID routed via direct BYOK)

1. **Opt-in per key.** Add `byok_api_keys.serve_catalog_models boolean not null default false` (migration). In the web UI (`BYOKKeysManager.tsx`) add a switch: "Use this key for matching Kilo catalog models". For organization keys, the switch is set by organization admins.
2. **Model list** (`handlers/models.ts`, `organization-models.ts`). For each catalog model with a routable mapping on an enabled, opted-in provider:
   - set the existing `hasUserByokAvailable: true` badge;
   - add a `byok_provider_id` hint;
   - drop the duplicate bespoke entries from the list. Unmapped bespoke models stay listed.
3. **Routing.** Add `checkUnifiedDirectBYOK` to `getProvider` (`providers/get-provider.ts`). Proposed precedence:
   - custom LLM;
   - explicit bespoke direct BYOK ID;
   - ChatGPT subscription;
   - Vercel BYOK (first-party key);
   - **unified direct BYOK**;
   - Kilo-paid routing.
4. **Choosing the upstream model.** Within one provider, prefer:
   - a normalized upstream tail equal to the catalog tail;
   - then the `recommended` flag;
   - then the shortest ID. This keeps `-flex`/`-fast` tiers reachable only by their bespoke IDs.

   Across providers, use the definition order for now. A user-defined order can come later if anyone asks.
5. **Request handling.** Use the same `transformRequest` as `checkDirectBYOK`, with `body.model` set to the chosen upstream ID. Return `userByok` set (which skips the balance check) and `bypassAccessCheck: false`, so organization allow/deny rules evaluate the **catalog** ID. This is the same model as ChatGPT BYOK. Before shipping, verify that provider-route policies (`groupProvidersAllowed`) do not reject the `direct-byok` provider.
6. **Usage.** Set `requested_model` to the catalog ID and keep `provider = 'direct-byok'`. Record the direct BYOK provider ID next to it. Decide whether `leaderboard-model-usage` should exclude `direct-byok`, as the provider-usage leaderboard already does.
7. **Failure behavior.** Do not silently fall back to Kilo credits after an upstream BYOK error, matching existing BYOK behavior. If a mapping disappears, the catalog ID routes as a normal Kilo-paid request, and the badge disappears from the list at the same time.
8. **Backward compatibility.** Bespoke IDs stay routable indefinitely. Favorites, `last_selected`, organization Auto targets and custom-router entries that store bespoke IDs are not rewritten. `model-preferences-router` filters favorites against available IDs, so it must also accept bespoke IDs that are hidden from the list. The alternative is to migrate favorites when the toggle is switched on.
9. **Rollout.** Ship behind the per-key toggle, which defaults off. Add a PostHog flag gating the UI switch for staged rollout.

### Phase 3 (explicitly deferred)

Renaming the bespoke IDs themselves (e.g. `synthetic/moonshotai/kimi-k2.6`) adds little once Phase 2 exists. It would also need a legacy alias layer for every stored ID and would still collide on serving-tier variants. Not planned.

## Testing

- **Resolver unit tests.** Use small fixture slices of models.dev and OpenRouter JSON covering each match method and each precision issue listed above.
- **Sync tests** (`sync-direct-byok.test.ts`): annotation, override handling and the coverage log.
- **Read path.** `convertModel` and handler tests check that `catalog_model_id` is emitted only for IDs present in the catalog.
- **Phase 2.** Add `get-provider` tests for the precedence and tie-break rules, organization policy evaluated on the catalog ID, and no access-check bypass. Add `handlers/models.test.ts` tests for badge and de-duplication, and model-preferences tests for hidden bespoke favorites.

## Open questions

1. **Kilo CLI and `canonical_slug`.** Does the Kilo CLI read `canonical_slug`? If not, should Phase 1 set `canonical_slug = catalog_model_id` instead of adding a new field?
2. **Precedence.** Should unified direct BYOK win over Vercel BYOK when a user has keys for both, e.g. OrcaRouter and Anthropic?
3. **Leaderboards.** Should unified BYOK traffic count toward catalog-model leaderboards and model usage stats?
4. **Personal toggles.** Should personal users get one global toggle instead of one per key? A per-key toggle mirrors the organization case and avoids surprising users who have several keys.
5. **Spec.** Should this become a `.specs/` business-rule document once Phase 2 is approved?
