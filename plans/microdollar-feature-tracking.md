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

  // CLI features (set by kilo-gateway via env var)
  'cli', // Kilo CLI direct human use

  // Cloud features (set by kilo-gateway via KILOCODE_FEATURE env var)
  'cloud-agent', // Cloud Agent sessions
  'code-review', // PR reviews (via cloud-agent)
  'auto-triage', // Issue auto-triage (via cloud-agent)
  'autofix', // Kilo Autofix (via cloud-agent)
  'app-builder', // App Builder (via cloud-agent)
  'agent-manager', // Agent Manager orchestrated tasks

  // Internal services (set by sendProxiedChatCompletion)
  'security-agent', // Security scanning
  'slack-bot', // Kilo for Slack

  // Other
  'kilo-claw', // Kilo Claw conversations
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
- **Slack Bot** ([`slack-bot.ts`](src/lib/slack-bot.ts:466)) → `feature: 'slack-bot'`

### Step 6: Old Extension — `Kilo-Org/kilocode` repo

1. Add `X_KILOCODE_FEATURE = "X-KiloCode-Feature"` to [`src/shared/kilocode/headers.ts`](https://github.com/Kilo-Org/kilocode/blob/main/src/shared/kilocode/headers.ts)
2. In [`customRequestOptions()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — determine the feature value based on context:
   - Check `getEditorNameHeader()`: if it contains "jetbrains", "intellij", "phpstorm", "webstorm", etc. → `'jetbrains-extension'`, otherwise → `'vscode-extension'`
   - The `metadata` parameter already carries context from each feature (mode, taskId), so parallel agents and managed indexing can override the value at their call sites
3. In [`streamFim()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — set to `'autocomplete'`

### Step 7: CLI Gateway + New Extension — `Kilo-Org/kilo` repo

In [`packages/kilo-gateway/src/api/constants.ts`](https://github.com/Kilo-Org/kilo/blob/main/packages/kilo-gateway/src/api/constants.ts):

```typescript
export const HEADER_FEATURE = 'X-KILOCODE-FEATURE';
export const DEFAULT_FEATURE = 'cli';
export const ENV_FEATURE = 'KILOCODE_FEATURE';
```

In the request-building code (where `HEADER_EDITORNAME` is set), also set:

```typescript
headers[HEADER_FEATURE] = process.env[ENV_FEATURE] || DEFAULT_FEATURE;
```

This covers both the new opencode-based extension (which uses kilo-gateway) and the CLI. Cloud features override via env var:

- **Cloud Agent** → `KILOCODE_FEATURE=cloud-agent`
- **Code Reviews** → `KILOCODE_FEATURE=code-review`
- **Auto-Triage** → `KILOCODE_FEATURE=auto-triage`
- **Kilo Autofix** → `KILOCODE_FEATURE=autofix`
- **App Builder** → `KILOCODE_FEATURE=app-builder`

### Step 8: Cloud Agent Environment (cloud repo)

In [`cloud-agent-next/src/kilo/server-manager.ts`](cloud-agent-next/src/kilo/server-manager.ts), [`buildKiloServeCommand`](cloud-agent-next/src/kilo/server-manager.ts:212) needs to include `KILOCODE_FEATURE={feature}` in the command. The feature value depends on what launched the session (cloud-agent vs code-review vs auto-triage vs auto-fix vs app-builder). Pass it as a parameter through the session creation flow.

**Without this, all cloud feature requests get tagged as `cli`.**

### Step 9: Kilo Claw (cloud repo)

In [`kiloclaw/src/gateway/env.ts`](kiloclaw/src/gateway/env.ts), add `KILOCODE_FEATURE: 'kilo-claw'` to the env vars passed to the sandbox in `buildEnvVars()`. Kilo Claw runs OpenClaw inside a Fly.io sandbox with the kilo CLI, so it goes through the same kilo-gateway path as cloud-agent.

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
| 6        | Add `KILOCODE_FEATURE=kilo-claw` to Kilo Claw env        | `cloud`    |

## Feature Coverage Matrix

| Feature             | How it sends the header                                                                | Value                 |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| VS Code Extension   | kilocode extension `customRequestOptions()`                                            | `vscode-extension`    |
| JetBrains Extension | kilocode extension `customRequestOptions()` (branches on editor name)                  | `jetbrains-extension` |
| Autocomplete        | kilocode extension `streamFim()`                                                       | `autocomplete`        |
| Parallel Agents     | kilocode extension (parallel agent code path)                                          | `parallel-agent`      |
| Managed Indexing    | kilocode extension (indexing code path)                                                | `managed-indexing`    |
| CLI                 | kilo-gateway default                                                                   | `cli`                 |
| Cloud Agent         | kilo-gateway + `KILOCODE_FEATURE=cloud-agent` env                                      | `cloud-agent`         |
| Code Reviews        | kilo-gateway + `KILOCODE_FEATURE=code-review` env                                      | `code-review`         |
| Auto-Triage         | kilo-gateway + `KILOCODE_FEATURE=auto-triage` env                                      | `auto-triage`         |
| Kilo Autofix        | kilo-gateway + `KILOCODE_FEATURE=autofix` env                                          | `autofix`             |
| App Builder         | kilo-gateway + `KILOCODE_FEATURE=app-builder` env                                      | `app-builder`         |
| Agent Manager       | kilo-gateway + `KILOCODE_FEATURE=agent-manager` env                                    | `agent-manager`       |
| Security Agent      | `sendProxiedChatCompletion` with `feature` field                                       | `security-agent`      |
| Slack Bot           | `sendProxiedChatCompletion` with `feature` field                                       | `slack-bot`           |
| Kilo Claw           | kilo-gateway + `KILOCODE_FEATURE=kilo-claw` env (set in `kiloclaw/src/gateway/env.ts`) | `kilo-claw`           |
| Direct Gateway      | `/api/gateway/` route wrapper injects `direct-gateway` when no feature header present  | `direct-gateway`      |
| Unattributed        | No header sent                                                                         | `NULL`                |

## Historical Data Backfill

For data before the `feature` column is populated, use the inference query in `plans/microdollar-feature-inference.sql` which joins `microdollar_usage` against feature-specific tables using 1-minute time windows and `editor_name` patterns.
