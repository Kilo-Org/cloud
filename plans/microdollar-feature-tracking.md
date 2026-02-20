# Microdollar Feature Tracking

## Problem

Track which feature/product generates each token usage record in `microdollar_usage`. Currently there's no way to distinguish features that share the same gateway endpoint. Per-feature WAU ends up overrelying on PostHog telemetry which loses a significant number of users to ad blockers.

## Solution

**One header, one column, validated at the gateway.** Every caller sends `X-KILOCODE-FEATURE: <value>`. The gateway validates it against an allow-list and stores it in `microdollar_usage_metadata.feature_id`. No header = NULL (unattributed). To add a new feature: add the value to the allow-list and have the caller send the header.

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

Feature is stored in a normalized lookup table `feature` (with `feature_id` FK in `microdollar_usage_metadata`). The `insertUsageAndMetadataWithBalanceUpdate` SQL uses a CTE to upsert the feature name and resolve the `feature_id`.

### Step 2: Feature Detection Module (cloud repo)

[`src/lib/feature-detection.ts`](src/lib/feature-detection.ts) contains:

- `FEATURE_VALUES` const array (the allow-list)
- `FeatureValue` type derived from the array
- `FEATURE_HEADER = 'x-kilocode-feature'` constant
- `validateFeatureHeader(headerValue: string | null): FeatureValue | null` — validates against the allow-list, returns null for invalid/missing values

### Step 3: processUsage Pipeline (cloud repo)

- `feature: FeatureValue | null` added to `MicrodollarUsageContext`
- `feature` included in `extractUsageContextInfo` return value
- `feature` flows through `toInsertableDbUsageRecord` into metadata
- `insertUsageAndMetadataWithBalanceUpdate` resolves feature name → `feature_id` via CTE

### Step 4: Gateway Entry Points (cloud repo)

Both gateway endpoints extract the `X-KILOCODE-FEATURE` header, call `validateFeatureHeader()`, and add the result to `usageContext`:

- [`/api/openrouter/[...path]/route.ts`](src/app/api/openrouter/[...path]/route.ts) — chat completions
- [`/api/fim/completions/route.ts`](src/app/api/fim/completions/route.ts) — FIM autocomplete

❌ **Not yet done:** [`/api/gateway/[...path]/route.ts`](src/app/api/gateway/[...path]/route.ts) is still a one-line re-export. It should inject `X-KILOCODE-FEATURE: direct-gateway` to positively identify external API consumers.

### Step 5: `sendProxiedChatCompletion` (cloud repo)

Optional `feature` field added to `ProxiedChatCompletionRequest`. When set, the `X-KILOCODE-FEATURE` header is included in the fetch call. Callers:

- **Security Agent** triage ([`triage-service.ts`](src/lib/security-agent/services/triage-service.ts)) and extraction ([`extraction-service.ts`](src/lib/security-agent/services/extraction-service.ts)) → `feature: 'security-agent'`
- **Slack Bot** ([`slack-bot.ts`](src/lib/slack-bot.ts)) → `feature: 'slack'`

### Step 6: Old Extension (`Kilo-Org/kilocode`)

The old extension sends the header directly from the VS Code/JetBrains extension process via `KilocodeOpenrouterHandler.customRequestOptions()`. The `resolveFeature()` method determines the value:

- Explicit metadata override (e.g. `'parallel-agent'`, `'autocomplete'`) → use it
- JetBrains wrapper detected → `'jetbrains-extension'`
- Agent Manager wrapper detected → `'agent-manager'`
- Default → `'vscode-extension'`

FIM autocomplete uses `feature: 'autocomplete'` passed through metadata in `streamFim()`.

### Step 7: New Extension + CLI (`Kilo-Org/kilo`)

The new extension spawns a local kilo CLI process which uses kilo-gateway to make API calls. The feature header is set via env var.

- **kilo-gateway** reads `KILOCODE_FEATURE` env var via `getFeatureHeader()` and includes it in `buildKiloHeaders()` when set
- **CLI entry point** (`packages/opencode/src/index.ts`) sets `KILOCODE_FEATURE` to `'cli'` for direct use, `'unknown'` for `kilo serve` without env var
- **VS Code extension** (`packages/kilo-vscode/src/services/cli-backend/server-manager.ts`) sets `KILOCODE_FEATURE: 'vscode-extension'` in the spawn env

⚠️ **Blocker:** The header code is on `main` but not yet released. Latest tag `v1.0.22` predates it. A new `@kilocode/cli` release is needed.

### Step 8: Cloud Feature Attribution (cloud repo + workers)

Both `cloud-agent` and `cloud-agent-next` workers set `KILOCODE_FEATURE` env var in the sandbox from the `createdOnPlatform` input field (defaults to `'cloud-agent'`). The kilo CLI inside the sandbox reads this env var and sends it as the `X-KILOCODE-FEATURE` header on every LLM request.

Callers that pass `createdOnPlatform`:

- **App Builder** → `'app-builder'` in [`app-builder-service.ts`](src/lib/app-builder/app-builder-service.ts) (createProject, sendMessage GitHub migration, prepareLegacySession)
- **Slack** → `'slack'` in [`slack-bot.ts`](src/lib/slack-bot.ts)
- **Security Agent** → `'security-agent'` in [`analysis-service.ts`](src/lib/security-agent/services/analysis-service.ts)
- **Code Reviews** → `'code-review'` in [`code-review-orchestrator.ts`](cloudflare-code-review-infra/src/code-review-orchestrator.ts)
- **Auto-Triage** → `'auto-triage'` in [`triage-orchestrator.ts`](cloudflare-auto-triage-infra/src/triage-orchestrator.ts)
- **Autofix** → `'autofix'` in [`fix-orchestrator.ts`](cloudflare-auto-fix-infra/src/fix-orchestrator.ts)
- **Webhook** → `'webhook'` in [`token-minting-service.ts`](cloudflare-webhook-agent-ingest/src/services/token-minting-service.ts)
- **Cloud Agent** (direct UI) → defaults to `'cloud-agent'`

⚠️ **Blocker:** The deployed CLI versions in both workers predate the header code. `cloud-agent` is on `v0.26.0`, `cloud-agent-next` is on `1.0.22`. Both need a version bump after a new CLI release.

### Step 9: KiloClaw (cloud repo)

[`kiloclaw/src/gateway/env.ts`](kiloclaw/src/gateway/env.ts) sets `KILOCODE_FEATURE = 'kilo-claw'` in the env vars passed to the sandbox. KiloClaw runs the kilo CLI inside a Fly.io sandbox, so it goes through the same kilo-gateway path.

## Feature Coverage Matrix

- **VS Code Extension** — old extension `customRequestOptions()` → `vscode-extension`
- **JetBrains Extension** — old extension `customRequestOptions()` (branches on `kiloCodeWrapperJetbrains`) → `jetbrains-extension`
- **Autocomplete** — old extension `streamFim()` + `AutocompleteModel.generateResponse()` → `autocomplete`
- **Parallel Agents** — old extension `customRequestOptions()` via `metadata.feature` (set in `Task.ts` when `parentTaskId`) → `parallel-agent`
- **Managed Indexing** — cloud repo server-side LLM calls (not from extension) → `managed-indexing`
- **CLI** — CLI entry point sets `cli` for non-serve commands; `unknown` for `kilo serve` without env var → `cli`
- **Cloud Agent** — kilo-gateway + `KILOCODE_FEATURE=cloud-agent` env → `cloud-agent`
- **Code Reviews** — CF worker passes `createdOnPlatform: 'code-review'` → session-service sets env → kilo-gateway sends header → `code-review`
- **Auto-Triage** — CF worker passes `createdOnPlatform: 'auto-triage'` → same flow → `auto-triage`
- **Kilo Autofix** — CF worker passes `createdOnPlatform: 'autofix'` → same flow → `autofix`
- **App Builder** — kilo-gateway + `KILOCODE_FEATURE=app-builder` env → `app-builder`
- **Agent Manager** — old extension `customRequestOptions()` (detects `kiloCodeWrapper === 'agent-manager'`) → `agent-manager`
- **Security Agent** — `sendProxiedChatCompletion` with `feature: 'security-agent'` (direct LLM calls) + `createdOnPlatform: 'security-agent'` (sandbox sessions) → `security-agent`
- **Slack** — `sendProxiedChatCompletion` with `feature: 'slack'` (direct LLM calls) + `createdOnPlatform: 'slack'` (spawned sessions) → `slack`
- **Webhook** — `createdOnPlatform: 'webhook'` via token minting → `webhook`
- **KiloClaw** — kilo-gateway + `KILOCODE_FEATURE=kilo-claw` env → `kilo-claw`
- **Direct Gateway** — ❌ not yet implemented, `/api/gateway/` needs wrapper to inject `direct-gateway`
- **Unattributed** — no header sent → `NULL`

## Remaining Work

- ❌ `/api/gateway/[...path]/route.ts` `direct-gateway` injection (Step 4)
- ❌ New `@kilocode/cli` release from `Kilo-Org/kilo` `main` (header code merged but unreleased)
- ❌ Bump `KILOCODE_CLI_VERSION` in `cloud-agent/wrangler.jsonc` (currently `v0.26.0`) and `cloud-agent-next/wrangler.jsonc` (currently `1.0.22`)

## Historical Data Backfill

For data before the `feature` column is populated, use the inference query in `plans/microdollar-feature-inference.sql` which joins `microdollar_usage` against feature-specific tables using 1-minute time windows and `editor_name` patterns.
