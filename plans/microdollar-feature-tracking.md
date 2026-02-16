# Microdollar Feature Tracking

## Problem

Track which feature/product generates each microdollar usage record. Currently extensions and autocomplete rely on telemetry — opted-out users are invisible. We also need to measure direct gateway API usage for marketing campaigns.

## Findings

### Schema

All token consumption lives in [`microdollar_usage`](src/db/schema.ts:549-582) with metadata in [`microdollar_usage_metadata`](src/db/schema.ts:584-619). No explicit field distinguishes which feature generated the usage.

### Deterministic Identifiers

1. **`provider = 'mistral'`** → autocomplete (100% confidence). FIM endpoint [`/api/fim/completions`](src/app/api/fim/completions/route.ts) exclusively uses this provider. Model defaults to [`codestral-2508`](src/lib/constants.ts:33).
2. **`editor_name`** → editor/CLI detection (high confidence when set, nullable). Stored in lookup table [`editor_name`](src/db/schema.ts:710-717), set via `X-KiloCode-EditorName` header. Needs version-number stripping. "Kilo Code CLI" and "opencode" (21% of traffic) both map to CLI category.

### Heuristic Identifiers (1-minute time window)

No direct identifier exists for cloud-agent or internal services in `microdollar_usage`. Detection requires joining on `kilo_user_id` + time window against feature-specific tables:

| Table | Feature | User ID Column |
|---|---|---|
| [`cli_sessions_v2`](src/db/schema.ts:2053-2094) | cloud-agent / cli | `kilo_user_id` (+ `created_on_platform`) |
| [`app_builder_projects`](src/db/schema.ts:2133) | app-builder | `owned_by_user_id` OR `created_by_user_id` |
| [`cloud_agent_code_reviews`](src/db/schema.ts:1902) | code-reviews | `owned_by_user_id` |
| [`code_indexing_manifest`](src/db/schema.ts:1545) / [`code_indexing_search`](src/db/schema.ts:1519) | managed-indexes | `kilo_user_id` |
| [`security_findings`](src/db/schema.ts:2226) | security-agent | `owned_by_user_id` |
| [`slack_bot_requests`](src/db/schema.ts:2338) | slack-bot | `owned_by_user_id` |

### Anonymous Usage

Format: `kilo_user_id LIKE 'anon:%'` (e.g. `anon:192.168.1.1`). Limited to gateway-direct and extensions with free models. Rate limited at 200 req/hour per IP.

### Short-Term Limitations

1. No positive identification of gateway-direct — falls into "unknown"
2. Time-bound heuristics are approximate (1-min window may misattribute)
3. OpenCode third-party agent accounts for 21% of traffic
4. Recent features may be under-detected if feature tables lag

## Feature Values

```typescript
const FEATURE_TYPES = [
  'cli',                     // Kilo CLI direct human use
  'extension',               // VS Code/Cursor/JetBrains chat/agent
  'extension-autocomplete',  // FIM completions
  'cloud-agent',             // Cloud Agent sessions
  'security-agent',          // Security scanning
  'app-builder',             // App Builder
  'code-review',             // PR reviews
  'auto-triage',             // Issue auto-triage
  'auto-fix',                // Issue auto-fix
  'kilo-claw',               // Kilo Claw conversations
  'agent-manager',           // Agent Manager orchestrated tasks
  'gateway-direct',          // Direct API calls / Kilo Gateway consumers
  'slack-bot',               // Kilo for Slack
  'unknown',                 // Cannot be determined
] as const;
```

Not tracked (no LLM gateway calls): Seats, Managed Indexing, Kilo for Data.
Editor distinction (vscode vs cursor vs jetbrains) uses existing `editor_name` field, not `feature`.

## Short-Term: Inference Query

Used to analyze historical data before the explicit field exists. Detection priority:

1. `provider = 'mistral'` → autocomplete
2. `editor_name` patterns → specific editors / CLI
3. Recent activity in feature-specific tables (1-min window) → cloud-agent, app-builder, code-reviews, managed-indexes, security-agent, slack-bot
4. `cli_sessions_v2.created_on_platform` → cloud-agent, cli, cli-other
5. Everything else → unknown

```sql
WITH base AS (
  SELECT
    mu.id,
    mu.kilo_user_id,
    mu.provider,
    mu.cost,
    mu.input_tokens,
    mu.output_tokens,
    mu.created_at,
    NULLIF(TRIM(en.editor_name), '') as editor_raw
  FROM backend_prod.public.microdollar_usage mu
  LEFT JOIN backend_prod.public.microdollar_usage_metadata mum ON mu.id = mum.id
  LEFT JOIN backend_prod.public.editor_name en ON mum.editor_name_id = en.editor_name_id
  WHERE mu.created_at >= CURRENT_DATE - INTERVAL '90 days'
),

clean AS (
  SELECT
    id,
    kilo_user_id,
    provider,
    cost,
    input_tokens,
    output_tokens,
    created_at,
    editor_raw,
    LOWER(TRIM(
      REGEXP_REPLACE(
        editor_raw,
        '\\s+v?[0-9]+(\\.[0-9]+){1,3}(-[A-Za-z0-9]+)?(\\+[0-9]+)?$',
        ''
      )
    )) as editor_lc
  FROM base
),

app_builder_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.app_builder_projects abp
    ON (abp.owned_by_user_id = c.kilo_user_id OR abp.created_by_user_id = c.kilo_user_id)
    AND abp.created_at <= c.created_at
    AND abp.created_at >= c.created_at - INTERVAL '1 minute'
),

code_review_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.cloud_agent_code_reviews cacr
    ON cacr.owned_by_user_id = c.kilo_user_id
    AND cacr.created_at <= c.created_at
    AND cacr.created_at >= c.created_at - INTERVAL '1 minute'
),

indexing_manifest_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.code_indexing_manifest cim
    ON cim.kilo_user_id = c.kilo_user_id
    AND cim.created_at <= c.created_at
    AND cim.created_at >= c.created_at - INTERVAL '1 minute'
),

indexing_search_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.code_indexing_search cis
    ON cis.kilo_user_id = c.kilo_user_id
    AND cis.created_at <= c.created_at
    AND cis.created_at >= c.created_at - INTERVAL '1 minute'
),

security_finding_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.security_findings sf
    ON sf.owned_by_user_id = c.kilo_user_id
    AND sf.created_at <= c.created_at
    AND sf.created_at >= c.created_at - INTERVAL '1 minute'
),

slack_bot_matches AS (
  SELECT DISTINCT c.id as usage_id
  FROM clean c
  INNER JOIN backend_prod.public.slack_bot_requests sbr
    ON sbr.owned_by_user_id = c.kilo_user_id
    AND sbr.created_at <= c.created_at
    AND sbr.created_at >= c.created_at - INTERVAL '1 minute'
),

cli_session_matches AS (
  SELECT
    c.id as usage_id,
    cs.created_on_platform,
    ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY cs.created_at DESC) as rn
  FROM clean c
  INNER JOIN backend_prod.public.cli_sessions_v2 cs
    ON cs.kilo_user_id = c.kilo_user_id
    AND cs.created_at <= c.created_at
    AND cs.created_at >= c.created_at - INTERVAL '1 minute'
),

cli_session_latest AS (
  SELECT usage_id, created_on_platform
  FROM cli_session_matches
  WHERE rn = 1
),

with_features AS (
  SELECT
    c.*,
    abm.usage_id as has_app_builder,
    crm.usage_id as has_code_reviews,
    imm.usage_id as has_indexing_manifest,
    ism.usage_id as has_indexing_search,
    sfm.usage_id as has_security_findings,
    sbm.usage_id as has_slack_bot,
    csm.created_on_platform as session_platform
  FROM clean c
  LEFT JOIN app_builder_matches abm ON abm.usage_id = c.id
  LEFT JOIN code_review_matches crm ON crm.usage_id = c.id
  LEFT JOIN indexing_manifest_matches imm ON imm.usage_id = c.id
  LEFT JOIN indexing_search_matches ism ON ism.usage_id = c.id
  LEFT JOIN security_finding_matches sfm ON sfm.usage_id = c.id
  LEFT JOIN slack_bot_matches sbm ON sbm.usage_id = c.id
  LEFT JOIN cli_session_latest csm ON csm.usage_id = c.id
)

SELECT
  DATE_TRUNC('day', created_at) as date,
  CASE
    WHEN provider = 'mistral' THEN 'autocomplete'
    WHEN editor_lc LIKE '%kilo code cli%' THEN 'cli'
    WHEN editor_lc LIKE 'opencode%' THEN 'cli'
    WHEN REGEXP_LIKE(editor_lc, '^(visual studio code|vscode|vs code|vscodium|code|code-oss|code-server)') THEN 'vscode'
    WHEN editor_lc LIKE 'cursor%' THEN 'cursor'
    WHEN editor_lc LIKE 'windsurf%' THEN 'windsurf'
    WHEN REGEXP_LIKE(editor_lc, '^(jetbrains|intellij|phpstorm|webstorm|rider|goland|clion|datagrip|rubymine|dataspell|android studio|pycharm|rustover)') THEN 'jetbrains'
    WHEN editor_lc LIKE 'antigravity%' THEN 'antigravity'
    WHEN editor_lc LIKE 'trae%' THEN 'trae'
    WHEN editor_raw IS NOT NULL THEN 'other-editor'
    WHEN has_app_builder IS NOT NULL THEN 'app-builder'
    WHEN has_code_reviews IS NOT NULL THEN 'code-reviews'
    WHEN has_indexing_manifest IS NOT NULL OR has_indexing_search IS NOT NULL THEN 'managed-indexes'
    WHEN has_security_findings IS NOT NULL THEN 'security-agent'
    WHEN has_slack_bot IS NOT NULL THEN 'slack-bot'
    WHEN session_platform = 'cloud-agent' THEN 'cloud-agent'
    WHEN session_platform IN ('cli', 'unknown') THEN 'cli'
    WHEN session_platform IS NOT NULL THEN 'cli-other'
    ELSE 'unknown'
  END as feature,
  COUNT(*) as usage_count,
  SUM(cost) as total_cost_microdollars,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens
FROM with_features
GROUP BY date, feature
ORDER BY date, feature;
```

## Long-Term: Add Explicit `feature` Column

### Step 1: Database Schema

Add nullable `feature` column to [`microdollar_usage`](src/db/schema.ts:549-582):

```sql
ALTER TABLE microdollar_usage ADD COLUMN feature TEXT;
CREATE INDEX idx_microdollar_usage_feature ON microdollar_usage(feature);
```

### Step 2: Update TypeScript Types and Data Flow

1. Add `FeatureType` and `detectFeature()` in new file `src/lib/feature-detection.ts`
2. Add `feature` to [`MicrodollarUsageContext`](src/lib/processUsage.ts:154-178) type
3. Update [`extractUsageContextInfo`](src/lib/processUsage.ts:181) to include `feature`
4. Update [`toInsertableDbUsageRecord`](src/lib/processUsage.ts:212) — destructure `feature` into core fields (not metadata)
5. **Critical:** Update raw SQL in [`insertUsageAndMetadataWithBalanceUpdate`](src/lib/processUsage.ts:470) — add `feature` to both column list and VALUES. If missed, column stays NULL in production.

### Step 3: Feature Detection Logic

Create `src/lib/feature-detection.ts`:
- Check `x-kilocode-feature` header first (most explicit)
- Fall back to user-agent for CLI detection (`kilo-cli`)
- Fall back to `editor_name` presence → `extension`
- Default to `gateway-direct` for authenticated calls

Validation: only accept values from the `FEATURE_TYPES` enum.

### Step 4: Update Gateway Entry Points

1. [`src/app/api/openrouter/[...path]/route.ts`](src/app/api/openrouter/[...path]/route.ts) — call `detectFeature()`, pass to `MicrodollarUsageContext`
2. [`src/app/api/fim/completions/route.ts`](src/app/api/fim/completions/route.ts) — same

### Step 5: Internal Services Send `X-KiloCode-Feature` Header

Each service sets the header on its LLM requests:
- Cloud Agent → `cloud-agent`
- Security Agent → `security-agent`
- App Builder → `app-builder`
- Slack Bot → `slack-bot`

### Step 6: Extension (Kilo-Org/kilocode repo)

1. Add `X_KILOCODE_FEATURE` constant to [`src/shared/kilocode/headers.ts`](https://github.com/Kilo-Org/kilocode/blob/main/src/shared/kilocode/headers.ts)
2. In [`customRequestOptions()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — default to `extension`
3. In [`streamFim()`](https://github.com/Kilo-Org/kilocode/blob/main/src/api/providers/kilocode-openrouter.ts) — override to `extension-autocomplete`

### Step 7: CLI Gateway (Kilo-Org/kilo repo)

In [`packages/kilo-gateway/src/api/constants.ts`](https://github.com/Kilo-Org/kilo/blob/main/packages/kilo-gateway/src/api/constants.ts):
- Add `HEADER_FEATURE = "X-KILOCODE-FEATURE"`, `DEFAULT_FEATURE = "cli"`, `ENV_FEATURE = "KILOCODE_FEATURE"`
- Read from env var `KILOCODE_FEATURE`, default to `cli`
- Include in request headers alongside `HEADER_EDITORNAME`

### Step 8: Cloud Agent Environment

Cloud agents run `kilo serve` (CLI) inside a sandbox. The agent must pass feature identity via env var.

In [`cloud-agent-next/src/kilo/server-manager.ts`](cloud-agent-next/src/kilo/server-manager.ts), set `KILOCODE_FEATURE: 'cloud-agent'` when launching `kilo serve`. Same pattern for any service that launches `kilo serve`.

**Without this, all cloud-agent requests get tagged as `cli`.**

### Migration Strategy

1. Add nullable column, deploy
2. Update code to detect and set feature, deploy
3. Optionally backfill historical data using heuristics from the inference query
4. After sufficient data, consider making column NOT NULL with default `unknown`
