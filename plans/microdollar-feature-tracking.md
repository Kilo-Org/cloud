# Microdollar Feature Tracking

## Problem

Track which feature/product generates each token usage record in `microdollar_usage`. Currently there's no way to distinguish features that share the same gateway endpoint. Per-feature WAU ends up overrelying on PostHog telemetry which loses a significant number of users to ad blockers.

## Solution

**One header, one column, validated at the gateway.** Every caller sends `X-KILOCODE-FEATURE: <value>`. The gateway validates it against an allow-list and stores it in `microdollar_usage.feature`. No header = NULL (unattributed). To add a new feature: add the value to the allow-list and have the caller send the header.

### Architecture

All LLM traffic flows through two gateway endpoints:

1. [`/api/openrouter/[...path]/route.ts`](src/app/api/openrouter/[...path]/route.ts) — chat completions
2. [`/api/fim/completions/route.ts`](src/app/api/fim/completions/route.ts) — autocomplete (FIM)

All callers set headers at one of three places:

1. **Old extension** → [`customRequestOptions()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) in `Kilo-Org/kilocode`
2. **New extension + CLI + Cloud features** → [`kilo-gateway/src/api/constants.ts`](https://github.com/Kilo-Org/kilo/blob/main/packages/kilo-gateway/src/api/constants.ts) in `Kilo-Org/kilo` (reads `KILOCODE_FEATURE` env var)
3. **Internal services** → [`sendProxiedChatCompletion`](src/lib/llm-proxy-helpers.ts:638) in `Kilo-Org/cloud`

## Feature Values

```typescript
const FEATURE_VALUES = [
  // Extension features (set by kilocode/kilo extension)
  'vscode-extension', // VS Code Extension AI interactions
  'jetbrains-extension', // JetBrains Extension AI interactions
  'autocomplete', // FIM completions (tab autocomplete)
  'parallel-agent', // Parallel Agents running inside VS Code
  'managed-indexing', // Managed Indexing LLM calls from extension
  'agent-manager', // Agent Manager orchestrated tasks (local extension)

  // CLI features (set by kilo-gateway via env var)
  'cli', // Kilo CLI direct human use

  // Cloud features (set by kilo-gateway via KILOCODE_FEATURE env var)
  'cloud-agent', // Cloud Agent sessions
  'code-review', // PR reviews (via cloud-agent)
  'auto-triage', // Issue auto-triage (via cloud-agent)
  'autofix', // Kilo Autofix (via cloud-agent)
  'app-builder', // App Builder (via cloud-agent)

  // Internal services (set by sendProxiedChatCompletion)
  'security-agent', // Security scanning
  'slack', // Kilo for Slack (both direct LLM calls and spawned sessions)
  'webhook', // Webhook agent

  // Other
  'kilo-claw', // KiloClaw conversations
] as const;
// NULL = no header sent (unattributed, e.g. direct gateway consumers or pre-rollout data)
```

**Not tracked** (no LLM gateway calls): Seats, Kilo Pass, AI Adoption Score, Auto Top Ups, Skills, Sessions, Voice Prompting, Deploy.

Editor distinction (vscode vs cursor vs jetbrains) uses existing `editor_name` field, not `feature`.

## Implementation

### Step 1: Database Schema (cloud repo)

Add nullable `feature` column to [`microdollar_usage`](src/db/schema.ts:549-582):

```sql
ALTER TABLE microdollar_usage ADD COLUMN feature TEXT;
CREATE INDEX idx_microdollar_usage_feature ON microdollar_usage(feature) WHERE feature IS NOT NULL;
```

Update Drizzle schema to include `feature: text()` in the table definition.

### Step 2: Create `src/lib/feature-detection.ts` (cloud repo)

New file with:

- `FEATURE_VALUES` const array (the allow-list)
- `FeatureValue` type derived from the array
- `FEATURE_HEADER = 'x-kilocode-feature'` constant
- `validateFeatureHeader(headerValue: string | null): FeatureValue | null` function:
  - If header is present and matches a valid `FeatureValue` → return it
  - Otherwise → return `null` (stored as NULL in the database)

No fallback heuristics in the write path. The column is nullable. If a caller doesn't send the header, the value is NULL.

### Step 3: Wire into processUsage Pipeline (cloud repo)

1. Add `feature: FeatureValue | null` to [`MicrodollarUsageContext`](src/lib/processUsage.ts:154-178)
2. Add `feature` to [`extractUsageContextInfo`](src/lib/processUsage.ts:181) return value
3. In [`toInsertableDbUsageRecord`](src/lib/processUsage.ts:205), destructure `feature` into core fields (alongside `kilo_user_id`, `organization_id`, `project_id`, `provider`)
4. **Critical:** In [`insertUsageAndMetadataWithBalanceUpdate`](src/lib/processUsage.ts:470), add `feature` to both the column list and VALUES in the raw SQL INSERT

### Step 4: Update Gateway Entry Points (cloud repo)

1. [`src/app/api/openrouter/[...path]/route.ts`](src/app/api/openrouter/[...path]/route.ts:253) — extract `X-KILOCODE-FEATURE` header, call `validateFeatureHeader()`, add to `usageContext`
2. [`src/app/api/fim/completions/route.ts`](src/app/api/fim/completions/route.ts:130) — same pattern
3. [`src/app/api/gateway/[...path]/route.ts`](src/app/api/gateway/[...path]/route.ts) — replace the one-line re-export with a wrapper that sets `X-KILOCODE-FEATURE: direct-gateway` on the request before forwarding to the openrouter handler. This positively identifies external API consumers without any dependency on them sending headers. No breaking change for consumers.

### Step 5: Update `sendProxiedChatCompletion` (cloud repo)

Add optional `feature` field to [`ProxiedChatCompletionRequest`](src/lib/llm-proxy-helpers.ts:622). When set, include `X-KILOCODE-FEATURE` header in the fetch call at [line 652](src/lib/llm-proxy-helpers.ts:652).

Update callers:

- **Security Agent** ([`extraction-service.ts`](src/lib/security-agent/services/extraction-service.ts:284), [`triage-service.ts`](src/lib/security-agent/services/triage-service.ts:237)) → `feature: 'security-agent'`
- **Slack Bot** ([`slack-bot.ts`](src/lib/slack-bot.ts:466)) → `feature: 'slack'`

### Step 6: Old Extension — `Kilo-Org/kilocode` repo

The old extension makes LLM calls directly from the VS Code/JetBrains extension process via `KilocodeOpenrouterHandler`. It does NOT use the kilo CLI or kilo-gateway.

1. Add `X_KILOCODE_FEATURE = "X-KiloCode-Feature"` to [`src/shared/kilocode/headers.ts`](https://github.com/Kilo-Org/kilocode/blob/main/src/shared/kilocode/headers.ts)
2. In [`customRequestOptions()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — determine the feature value based on context:
   - Check `getEditorNameHeader()`: if it contains "jetbrains", "intellij", "phpstorm", "webstorm", etc. → `'jetbrains-extension'`, otherwise → `'vscode-extension'`
   - The `metadata` parameter already carries context from each feature (mode, taskId), so parallel agents, managed indexing, and agent-manager can override the value at their call sites
3. In [`streamFim()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — set to `'autocomplete'`

Features covered by this step: `vscode-extension`, `jetbrains-extension`, `autocomplete`, `parallel-agent`, `managed-indexing`, `agent-manager`

### Step 7: CLI + New Extension — `Kilo-Org/kilo` repo

The new extension (packages/kilo-vscode + packages/opencode) uses a different architecture: it spawns a local kilo CLI process which uses kilo-gateway to make API calls. This means the feature header is set via env var on the spawned process, not via extension code.

**7a. kilo-gateway constants and headers:**

In [`packages/kilo-gateway/src/api/constants.ts`](https://github.com/Kilo-Org/kilo/blob/main/packages/kilo-gateway/src/api/constants.ts):

```typescript
export const HEADER_FEATURE = 'X-KILOCODE-FEATURE';
export const ENV_FEATURE = 'KILOCODE_FEATURE';
// No DEFAULT_FEATURE constant — avoids silent misattribution when callers forget the env var
```

Add `getFeatureHeader()` (returns `undefined` when env var not set) and conditionally include the feature header in `buildKiloHeaders()`. Export from `packages/kilo-gateway/src/index.ts`.

**7d. CLI entry point default (`packages/opencode/src/index.ts`):**

The CLI entry point detects whether it's running as `kilo serve` (spawned by another service) or direct CLI use:

```typescript
if (!process.env[ENV_FEATURE]) {
  const isServe = process.argv.includes('serve');
  process.env[ENV_FEATURE] = isServe ? 'unknown' : 'cli';
}
```

- Direct CLI (`kilo`, `kilo run`) → `cli`
- Spawned `kilo serve` without env var → `unknown` (misconfiguration visible in data)
- Spawned `kilo serve` with env var → whatever the caller set

**7b. FIM route fix (new extension autocomplete):**

The FIM route at `packages/kilo-gateway/src/server/routes.ts:214` makes a direct `fetch()` to `/api/fim/completions` bypassing `buildKiloHeaders()`. This is specific to the kilo repo (the old kilocode repo has its own `streamFim()` in Step 6). Add `...buildKiloHeaders()` to the FIM fetch headers plus a hardcoded `[HEADER_FEATURE]: 'autocomplete'` override.

**7c. New VS Code extension spawn env:**

`packages/kilo-vscode/src/services/cli-backend/server-manager.ts:64` spawns the kilo CLI for the new VS Code extension. This is specific to the kilo repo (the old kilocode repo doesn't spawn a CLI). Add `KILOCODE_FEATURE: 'vscode-extension'` to the spawn env. Without this, all new extension requests get tagged as `cli` (the default).

Features covered by this step: `cli` (direct CLI use), `vscode-extension` (new extension), `autocomplete` (new extension FIM), `unknown` (misconfigured `kilo serve` spawner). Cloud features are handled by Step 8 (cloud repo sets the env var before spawning, kilo-gateway just reads it).

### Step 8: Cloud Feature Attribution (cloud repo)

In [`cloud-agent-next/src/session-service.ts`](cloud-agent-next/src/session-service.ts:475) and [`cloud-agent/src/session-service.ts`](cloud-agent/src/session-service.ts:467), add `KILOCODE_FEATURE: createdOnPlatform ?? 'cloud-agent'` to the sandbox env vars (alongside `KILO_PLATFORM`). The `createdOnPlatform` value is passed by the callers:

- **App Builder** → `'app-builder'` (already set in `src/lib/app-builder/app-builder-service.ts`)
- **Slack** → `'slack'` (already set in `src/lib/slack-bot.ts`)
- **Cloud Agent** (direct) → `'cloud-agent'` (default)

The following CF workers need `createdOnPlatform` added to their session input:

- **Code Reviews** → `'code-review'` in [`cloudflare-code-review-infra/src/code-review-orchestrator.ts`](cloudflare-code-review-infra/src/code-review-orchestrator.ts)
- **Auto-Triage** → `'auto-triage'` in [`cloudflare-auto-triage-infra/src/triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts)
- **Autofix** → `'autofix'` in [`cloudflare-auto-fix-infra/src/fix-orchestrator.ts`](cloudflare-auto-fix-infra/src/fix-orchestrator.ts)

### Step 9: KiloClaw (cloud repo)

In [`kiloclaw/src/gateway/env.ts`](kiloclaw/src/gateway/env.ts), add `KILOCODE_FEATURE: 'kilo-claw'` to the env vars passed to the sandbox in `buildEnvVars()`. KiloClaw runs OpenClaw inside a Fly.io sandbox with the kilo CLI, so it goes through the same kilo-gateway path as cloud-agent.

### Step 10: Update Test Helpers (cloud repo)

Add `feature` to:

- [`createBaseUsageContext`](src/lib/processUsage.test.ts:311) in processUsage tests
- [`createMockUsageContext`](src/tests/helpers/microdollar-usage.helper.ts:82) in test helper
- [`defineDefaultContextInfo`](src/tests/helpers/microdollar-usage.helper.ts:35) in test helper
- [`/api/dev/consume-credits`](src/app/api/dev/consume-credits/route.ts:66) dev route

## Deployment Order

No strict dependencies between repos. Backend first is recommended so the column exists when callers start sending the header. Callers can be deployed in any order after that.

| Priority | Change                                                   | Repo       |
| -------- | -------------------------------------------------------- | ---------- |
| 1        | Add `feature` column + validation logic + gateway wiring | `cloud`    |
| 2        | Add `HEADER_FEATURE` to kilo-gateway                     | `kilo`     |
| 3        | Pass `KILOCODE_FEATURE` env var in cloud-agent-next      | `cloud`    |
| 4        | Add `X-KiloCode-Feature` header to old extension         | `kilocode` |
| 5        | Add feature to `sendProxiedChatCompletion` callers       | `cloud`    |
| 6        | Add `KILOCODE_FEATURE=kilo-claw` to KiloClaw env         | `cloud`    |

## Feature Coverage Matrix

| Feature             | How it sends the header                                                                                    | Value                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| VS Code Extension   | kilocode extension `customRequestOptions()`                                                                | `vscode-extension`    |
| JetBrains Extension | kilocode extension `customRequestOptions()` (branches on editor name)                                      | `jetbrains-extension` |
| Autocomplete        | kilocode extension `streamFim()`                                                                           | `autocomplete`        |
| Parallel Agents     | kilocode extension (parallel agent code path)                                                              | `parallel-agent`      |
| Managed Indexing    | kilocode extension (indexing code path)                                                                    | `managed-indexing`    |
| CLI                 | CLI entry point sets `cli` for non-serve commands; `unknown` for `kilo serve` without env var              | `cli`                 |
| Cloud Agent         | kilo-gateway + `KILOCODE_FEATURE=cloud-agent` env                                                          | `cloud-agent`         |
| Code Reviews        | CF worker passes `createdOnPlatform: 'code-review'` → session-service sets env → kilo-gateway sends header | `code-review`         |
| Auto-Triage         | CF worker passes `createdOnPlatform: 'auto-triage'` → session-service sets env → kilo-gateway sends header | `auto-triage`         |
| Kilo Autofix        | CF worker passes `createdOnPlatform: 'autofix'` → session-service sets env → kilo-gateway sends header     | `autofix`             |
| App Builder         | kilo-gateway + `KILOCODE_FEATURE=app-builder` env                                                          | `app-builder`         |
| Agent Manager       | kilocode extension (agent-manager code path)                                                               | `agent-manager`       |
| Security Agent      | `sendProxiedChatCompletion` with `feature: 'security-agent'`                                               | `security-agent`      |
| Slack               | `sendProxiedChatCompletion` with `feature: 'slack'` + `createdOnPlatform: 'slack'` for spawned sessions    | `slack`               |
| Webhook             | `createdOnPlatform: 'webhook'` via token minting (separate worker, rolls up into Cloud Agents for WAU)     | `webhook`             |
| KiloClaw            | kilo-gateway + `KILOCODE_FEATURE=kilo-claw` env (set in `kiloclaw/src/gateway/env.ts`)                     | `kilo-claw`           |
| Direct Gateway      | `/api/gateway/` route wrapper injects `direct-gateway` when no feature header present                      | `direct-gateway`      |
| Unattributed        | No header sent                                                                                             | `NULL`                |

## Historical Data Backfill

For data before the `feature` column is populated, use the inference query in `plans/microdollar-feature-inference.sql` which joins `microdollar_usage` against feature-specific tables using 1-minute time windows and `editor_name` patterns.
