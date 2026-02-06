# Security Agent: Source Provider Abstraction Plan

## Problem Statement

The sync layer is hardcoded to Dependabot. Four approved proposals (CodeQL, Webhooks,
SLA Dashboard, Fix PRs) and future integrations (Snyk, Vanta) all need multi-source
ingestion. Today, adding a new source means duplicating sync logic, creating parallel
cron jobs, and scattering source-specific conditionals across the router.

The goal is a **provider abstraction** that makes adding a new security source a
self-contained, single-directory change — no modifications to the sync orchestrator,
cron jobs, router, or analysis pipeline.

---

## Current Coupling Points (What Must Change)

| Location | Coupling | Required Change |
|---|---|---|
| `schema.ts:2252` | `dependabot_html_url` column | Rename to `source_url` |
| `schema.ts:2271` | `raw_data` typed as `DependabotAlertRaw` | Change to generic `Record<string, unknown>` |
| `schema.ts:2221` | `source: text()` comment lists only 3 values | Update comment, no code change needed |
| `sync-service.ts` | `syncDependabotAlertsForRepo()` hardcoded | Replace with provider-based orchestrator |
| `sync-service.ts:189` | `agent_type: 'security_scan'` only | Keep — one config per owner, providers share it |
| `security-agent-router.ts:380-468` | `triggerSync` hardcoded to GitHub integration | Delegate to provider registry |
| `security-agent-router.ts:522-535` | `dismissFinding` has `if (source === 'dependabot')` | Delegate to provider's `dismissAlert()` |
| `types.ts:131-175` | `DependabotAlertRaw` used as the canonical raw type | Move to Dependabot provider |
| `types.ts:86-98` | `mapDependabotStateToStatus()` | Move to Dependabot provider |
| `dependabot-parser.ts` | Standalone parser | Move into Dependabot provider module |
| `dependabot-api.ts` | Standalone API client | Move into Dependabot provider module |
| `permissions.ts` | Standalone permission check | Move into Dependabot provider module |
| `cron/sync-security-alerts/route.ts` | Calls `runFullSync()` directly | No change — `runFullSync()` becomes provider-aware |

---

## Provider Interface Design

```typescript
// src/lib/security-agent/providers/types.ts

import type { ParsedSecurityFinding, SecurityReviewOwner, SyncResult } from '../core/types';
import type { PlatformIntegration } from '@/db/schema';

/**
 * Source identifier — must match the `source` column value in security_findings.
 * Each provider owns exactly one source identifier.
 */
export type SecuritySourceId = 'dependabot' | 'code_scanning' | 'snyk' | 'vanta' | string;

/**
 * Context passed to every provider method.
 * Contains the resolved owner, integration, and config.
 */
export type ProviderContext = {
  owner: SecurityReviewOwner;
  integration: PlatformIntegration;
  installationId: string;
};

/**
 * Dismiss reason — normalized across sources.
 * Each provider maps these to its upstream API's expected values.
 */
export type DismissReason =
  | 'fix_started'
  | 'no_bandwidth'
  | 'tolerable_risk'
  | 'inaccurate'
  | 'not_used';

/**
 * Permission check result — uniform across providers.
 */
export type ProviderPermissionCheck =
  | { hasPermission: true }
  | {
      hasPermission: false;
      error: string;
      message: string;
      requiredPermissions: string[];
      reauthorizeUrl?: string;
    };

/**
 * The core abstraction. Each security source implements this interface.
 *
 * Design principles:
 * - All methods receive a ProviderContext so providers don't manage auth themselves
 * - fetchAlerts() returns ParsedSecurityFinding[] — the existing normalization type
 * - dismissAlert() is optional — not all sources support upstream dismissal
 * - checkPermissions() validates prerequisites before sync attempts
 * - supportsWebhook() enables the sync orchestrator to skip polling for event-driven sources
 */
export interface SecuritySourceProvider {
  /** Unique source identifier (stored in security_findings.source) */
  readonly sourceId: SecuritySourceId;

  /** Human-readable name for UI display */
  readonly displayName: string;

  /** Platform this provider requires (e.g., 'github', 'snyk', 'vanta') */
  readonly platform: string;

  /**
   * Check if the integration has required permissions for this provider.
   * Called before sync to give actionable error messages.
   */
  checkPermissions(integration: PlatformIntegration): ProviderPermissionCheck;

  /**
   * Fetch all alerts for a single repository and return normalized findings.
   * The provider handles pagination, API auth, and parsing internally.
   *
   * @param ctx - Owner, integration, and installation context
   * @param repoFullName - Repository in "owner/repo" format
   * @returns Normalized findings ready for upsert
   */
  fetchAlerts(ctx: ProviderContext, repoFullName: string): Promise<ParsedSecurityFinding[]>;

  /**
   * Dismiss an alert at the upstream source.
   * Returns void — the caller handles local DB status update.
   * Return null if this source does not support upstream dismissal.
   */
  dismissAlert?(
    ctx: ProviderContext,
    repoFullName: string,
    sourceId: string,
    reason: DismissReason,
    comment?: string
  ): Promise<void>;

  /**
   * Whether this provider can receive real-time events via webhooks.
   * When true, the sync orchestrator can skip polling for this provider
   * when webhook-based sync is active.
   */
  supportsWebhook: boolean;

  /**
   * Optional: process an incoming webhook payload.
   * Returns findings to upsert, or null if the event is not relevant.
   * Only called if supportsWebhook is true.
   */
  handleWebhookEvent?(
    ctx: ProviderContext,
    eventType: string,
    payload: unknown
  ): Promise<ParsedSecurityFinding[] | null>;
}
```

---

## Provider Registry

```typescript
// src/lib/security-agent/providers/registry.ts

import type { SecuritySourceProvider, SecuritySourceId } from './types';

/**
 * Registry of all security source providers.
 * Providers self-register at import time.
 *
 * The registry is the single entry point for the sync orchestrator,
 * cron jobs, routers, and webhook handler. No code outside the
 * providers/ directory needs to know about specific sources.
 */
class SecuritySourceRegistry {
  private providers = new Map<SecuritySourceId, SecuritySourceProvider>();

  register(provider: SecuritySourceProvider): void {
    if (this.providers.has(provider.sourceId)) {
      throw new Error(`Provider already registered: ${provider.sourceId}`);
    }
    this.providers.set(provider.sourceId, provider);
  }

  get(sourceId: SecuritySourceId): SecuritySourceProvider | undefined {
    return this.providers.get(sourceId);
  }

  /** Get all providers for a given platform (e.g., all GitHub-based providers) */
  getByPlatform(platform: string): SecuritySourceProvider[] {
    return Array.from(this.providers.values()).filter(p => p.platform === platform);
  }

  /** Get all registered providers */
  getAll(): SecuritySourceProvider[] {
    return Array.from(this.providers.values());
  }
}

export const sourceRegistry = new SecuritySourceRegistry();
```

---

## Provider Implementations

### Directory Structure

```
src/lib/security-agent/providers/
├── types.ts                       # SecuritySourceProvider interface
├── registry.ts                    # Singleton registry
├── index.ts                       # Re-exports + auto-registers all providers
│
├── dependabot/
│   ├── index.ts                   # DependabotProvider implements SecuritySourceProvider
│   ├── api.ts                     # ← moved from github/dependabot-api.ts
│   ├── parser.ts                  # ← moved from parsers/dependabot-parser.ts
│   ├── permissions.ts             # ← moved from github/permissions.ts
│   └── types.ts                   # DependabotAlertRaw, state mapping
│
├── code-scanning/                 # Proposal 1: CodeQL
│   ├── index.ts                   # CodeScanningProvider implements SecuritySourceProvider
│   ├── api.ts                     # GitHub Code Scanning REST API client
│   ├── parser.ts                  # Alert → ParsedSecurityFinding mapper
│   └── types.ts                   # CodeScanningAlertRaw
│
├── snyk/                          # Future: Snyk
│   ├── index.ts                   # SnykProvider implements SecuritySourceProvider
│   ├── api.ts                     # Snyk REST API client
│   ├── parser.ts                  # Issue → ParsedSecurityFinding mapper
│   └── types.ts                   # SnykIssueRaw
│
└── vanta/                         # Future: Vanta
    ├── index.ts                   # VantaProvider implements SecuritySourceProvider
    ├── api.ts                     # Vanta API client
    ├── parser.ts                  # Vulnerability → ParsedSecurityFinding mapper
    └── types.ts                   # VantaVulnerabilityRaw
```

### Example: Dependabot Provider

```typescript
// src/lib/security-agent/providers/dependabot/index.ts

import { sourceRegistry } from '../registry';
import type { SecuritySourceProvider, ProviderContext, ProviderPermissionCheck } from '../types';
import type { PlatformIntegration } from '@/db/schema';
import type { ParsedSecurityFinding } from '../../core/types';
import { fetchAllDependabotAlerts, dismissDependabotAlert } from './api';
import { parseDependabotAlerts } from './parser';
import { hasSecurityReviewPermissions, checkSecurityReviewPermissions } from './permissions';

const dependabotProvider: SecuritySourceProvider = {
  sourceId: 'dependabot',
  displayName: 'GitHub Dependabot',
  platform: 'github',
  supportsWebhook: true, // Will handle dependabot_alert events (Proposal 3)

  checkPermissions(integration: PlatformIntegration): ProviderPermissionCheck {
    return checkSecurityReviewPermissions(integration);
  },

  async fetchAlerts(ctx: ProviderContext, repoFullName: string): Promise<ParsedSecurityFinding[]> {
    const [owner, repo] = repoFullName.split('/');
    const alerts = await fetchAllDependabotAlerts(ctx.installationId, owner, repo);
    return parseDependabotAlerts(alerts, repoFullName);
  },

  async dismissAlert(ctx, repoFullName, sourceId, reason, comment): Promise<void> {
    const [owner, repo] = repoFullName.split('/');
    const alertNumber = parseInt(sourceId, 10);
    if (!isNaN(alertNumber)) {
      await dismissDependabotAlert(ctx.installationId, owner, repo, alertNumber, reason, comment);
    }
  },

  async handleWebhookEvent(ctx, eventType, payload): Promise<ParsedSecurityFinding[] | null> {
    if (eventType !== 'dependabot_alert') return null;
    // Parse the single alert from webhook payload
    // Return as ParsedSecurityFinding[] for upsert
    // ... (implementation for Proposal 3)
    return null;
  },
};

// Self-register
sourceRegistry.register(dependabotProvider);
export default dependabotProvider;
```

### Example: CodeQL Provider (Proposal 1)

```typescript
// src/lib/security-agent/providers/code-scanning/index.ts

import { sourceRegistry } from '../registry';
import type { SecuritySourceProvider, ProviderContext, ProviderPermissionCheck } from '../types';
import type { PlatformIntegration } from '@/db/schema';
import type { ParsedSecurityFinding } from '../../core/types';
import { fetchCodeScanningAlerts, dismissCodeScanningAlert } from './api';
import { parseCodeScanningAlerts } from './parser';

const codeScanningProvider: SecuritySourceProvider = {
  sourceId: 'code_scanning',
  displayName: 'GitHub Code Scanning (CodeQL)',
  platform: 'github',
  supportsWebhook: true, // Handles code_scanning_alert events

  checkPermissions(integration: PlatformIntegration): ProviderPermissionCheck {
    const permissions = integration.permissions;
    if (permissions?.security_events === 'read' || permissions?.security_events === 'write') {
      return { hasPermission: true };
    }
    return {
      hasPermission: false,
      error: 'missing_permissions',
      message: 'Code Scanning requires the security_events permission.',
      requiredPermissions: ['security_events'],
      reauthorizeUrl: `https://github.com/apps/KiloConnect/installations/${integration.platform_installation_id}`,
    };
  },

  async fetchAlerts(ctx: ProviderContext, repoFullName: string): Promise<ParsedSecurityFinding[]> {
    const [owner, repo] = repoFullName.split('/');
    const alerts = await fetchCodeScanningAlerts(ctx.installationId, owner, repo);
    return parseCodeScanningAlerts(alerts, repoFullName);
  },

  async dismissAlert(ctx, repoFullName, sourceId, reason, comment): Promise<void> {
    const [owner, repo] = repoFullName.split('/');
    await dismissCodeScanningAlert(ctx.installationId, owner, repo, parseInt(sourceId, 10), reason);
  },

  async handleWebhookEvent(ctx, eventType, payload): Promise<ParsedSecurityFinding[] | null> {
    if (eventType !== 'code_scanning_alert') return null;
    // Parse single alert from webhook payload
    return null;
  },
};

sourceRegistry.register(codeScanningProvider);
export default codeScanningProvider;
```

### Example: Snyk Provider (Future)

```typescript
// src/lib/security-agent/providers/snyk/index.ts
// Demonstrates a non-GitHub provider

import { sourceRegistry } from '../registry';
import type { SecuritySourceProvider, ProviderContext, ProviderPermissionCheck } from '../types';
import type { PlatformIntegration } from '@/db/schema';
import type { ParsedSecurityFinding } from '../../core/types';
import { fetchSnykIssues } from './api';
import { parseSnykIssues } from './parser';

const snykProvider: SecuritySourceProvider = {
  sourceId: 'snyk',
  displayName: 'Snyk',
  platform: 'snyk', // Different platform — requires its own integration in platform_integrations
  supportsWebhook: true, // Snyk supports outbound webhooks

  checkPermissions(integration: PlatformIntegration): ProviderPermissionCheck {
    // Snyk uses API tokens, not GitHub App permissions
    if (integration.platform_api_token) {
      return { hasPermission: true };
    }
    return {
      hasPermission: false,
      error: 'missing_credentials',
      message: 'Snyk integration requires an API token.',
      requiredPermissions: ['api_token'],
    };
  },

  async fetchAlerts(ctx: ProviderContext, repoFullName: string): Promise<ParsedSecurityFinding[]> {
    // Snyk uses org/project IDs, not owner/repo — map from repoFullName
    const issues = await fetchSnykIssues(ctx.integration, repoFullName);
    return parseSnykIssues(issues, repoFullName);
  },

  // Snyk doesn't support dismissal via API in the same way
  dismissAlert: undefined,

  async handleWebhookEvent(ctx, eventType, payload): Promise<ParsedSecurityFinding[] | null> {
    if (eventType !== 'snyk.issue.new' && eventType !== 'snyk.issue.updated') return null;
    // Parse Snyk webhook payload
    return null;
  },
};

sourceRegistry.register(snykProvider);
export default snykProvider;
```

---

## Refactored Sync Orchestrator

```typescript
// src/lib/security-agent/services/sync-service.ts (refactored)

import { sourceRegistry } from '../providers/registry';
import type { SecuritySourceProvider, ProviderContext } from '../providers/types';
import type { SecurityReviewOwner, SyncResult } from '../core/types';
import { upsertSecurityFinding } from '../db/security-findings';
import { getSecurityAgentConfig } from '../db/security-config';
import { getSlaForSeverity, calculateSlaDueAt } from '../core/types';

/**
 * Sync all providers for a single repository.
 * The orchestrator iterates over registered providers that match
 * the integration's platform and have valid permissions.
 */
export async function syncRepoAllProviders(params: {
  owner: SecurityReviewOwner;
  ctx: ProviderContext;
  repoFullName: string;
}): Promise<SyncResult> {
  const { owner, ctx, repoFullName } = params;
  const config = await getSecurityAgentConfig(/* ... */);
  const providers = sourceRegistry.getByPlatform(ctx.integration.platform);
  const result: SyncResult = { synced: 0, created: 0, updated: 0, errors: 0 };

  for (const provider of providers) {
    // Check permissions before attempting fetch
    const permCheck = provider.checkPermissions(ctx.integration);
    if (!permCheck.hasPermission) {
      console.log(`[sync] ${provider.displayName} skipped: ${permCheck.message}`);
      continue;
    }

    try {
      const findings = await provider.fetchAlerts(ctx, repoFullName);

      for (const finding of findings) {
        try {
          const slaDays = getSlaForSeverity(config, finding.severity);
          const slaDueAt = calculateSlaDueAt(finding.first_detected_at, slaDays);

          await upsertSecurityFinding({
            ...finding,
            owner,
            platformIntegrationId: ctx.integration.id,
            repoFullName,
            slaDueAt,
          });
          result.synced++;
        } catch {
          result.errors++;
        }
      }
    } catch (error) {
      console.error(`[sync] ${provider.displayName} failed for ${repoFullName}:`, error);
      result.errors++;
    }
  }

  return result;
}

/**
 * runFullSync() remains the cron entry point.
 * It now iterates providers per-platform instead of hardcoding Dependabot.
 */
export async function runFullSync(): Promise<{
  totalSynced: number;
  totalErrors: number;
  configsProcessed: number;
}> {
  const configs = await getEnabledSecurityReviewConfigs();

  let totalSynced = 0;
  let totalErrors = 0;

  for (const config of configs) {
    for (const repoFullName of config.repositories) {
      const ctx: ProviderContext = {
        owner: config.owner,
        integration: config.integration,
        installationId: config.installationId,
      };

      const result = await syncRepoAllProviders({
        owner: config.owner,
        ctx,
        repoFullName,
      });

      totalSynced += result.synced;
      totalErrors += result.errors;
    }
  }

  return { totalSynced, totalErrors, configsProcessed: configs.length };
}
```

---

## Refactored Router Dismiss Flow

```typescript
// In security-agent-router.ts, the dismissFinding handler becomes:

dismissFinding: baseProcedure
  .input(DismissFindingInputSchema)
  .mutation(async ({ input, ctx }) => {
    const finding = await getSecurityFindingById(input.findingId);
    // ... ownership checks ...

    // Delegate upstream dismissal to the appropriate provider
    const provider = sourceRegistry.get(finding.source);
    if (provider?.dismissAlert) {
      const providerCtx = await buildProviderContext(ctx, finding);
      await provider.dismissAlert(
        providerCtx,
        finding.repo_full_name,
        finding.source_id,
        input.reason,
        input.comment
      );
    }

    // Update local database (always, regardless of provider)
    await updateSecurityFindingStatus(input.findingId, 'ignored', {
      ignoredReason: input.reason,
      ignoredBy: ctx.user.google_user_email,
    });

    return { success: true };
  }),
```

---

## Schema Migration

A single migration handles all schema changes. This is intentionally minimal —
only the two Dependabot-specific items change.

```sql
-- Migration: Generalize Dependabot-specific columns

-- 1. Rename dependabot_html_url → source_url
ALTER TABLE security_findings RENAME COLUMN dependabot_html_url TO source_url;

-- 2. Update comment on raw_data (no actual schema change — JSONB is already untyped)
-- The TypeScript type annotation changes from $type<DependabotAlertRaw>() to
-- $type<Record<string, unknown>>(), but the column itself is unchanged.

-- 3. Add index on source column for provider-based queries
CREATE INDEX IF NOT EXISTS idx_security_findings_source ON security_findings (source);
```

Corresponding Drizzle schema changes:

```typescript
// In schema.ts — two changes:

// Before:
dependabot_html_url: text(),
raw_data: jsonb().$type<DependabotAlertRaw>(),

// After:
source_url: text(),    // URL to the finding in its source system
raw_data: jsonb().$type<Record<string, unknown>>(),
```

**Backwards compatibility**: The `source_url` rename requires updating all
references from `dependabot_html_url` → `source_url`. Grep shows these exist in:
- `security-findings.ts` (upsert/create)
- `dependabot-parser.ts` (sets the field)
- UI components that link to the alert

All are straightforward find-and-replace within the security-agent module.

---

## Webhook Integration (Proposal 3)

The provider abstraction directly enables webhook-based sync:

```typescript
// In webhook-handler.ts — add to the event router:

case 'dependabot_alert':
case 'code_scanning_alert': {
  const sourceId = eventType === 'dependabot_alert' ? 'dependabot' : 'code_scanning';
  const provider = sourceRegistry.get(sourceId);
  if (provider?.handleWebhookEvent) {
    const ctx = await buildProviderContextFromWebhook(integration);
    const findings = await provider.handleWebhookEvent(ctx, eventType, payload);
    if (findings) {
      for (const finding of findings) {
        await upsertSecurityFinding({ ...finding, owner, /* ... */ });
      }
    }
  }
  break;
}
```

The webhook handler doesn't need to know about provider internals — it just
routes the event type to the correct provider and upserts the result.

---

## Impact on Each Approved Proposal

### Proposal 1: CodeQL Integration

**With this abstraction**: Create `providers/code-scanning/` directory with 4 files.
Register the provider. Done. No changes to sync-service, cron, router, or analysis pipeline.

**Without this abstraction**: Duplicate sync-service logic, add `if (source === 'code_scanning')`
branches in the router, create a separate cron job or fork `runFullSync()`.

### Proposal 2: Fix PR Generation

**Impact**: None. The analysis pipeline and `SandboxSuggestedAction.OPEN_PR` are already
source-agnostic. Fix PR generation operates on `SecurityFinding` records regardless of
which provider ingested them. The `source_url` field gives context for PR descriptions.

### Proposal 3: Webhook Sync + Slack Notifications

**With this abstraction**: Add `handleWebhookEvent()` to each provider. The webhook
handler routes events by type, delegates to the provider, and upserts findings.
Slack notifications trigger on upsert (severity threshold check) independent of source.

**Without this abstraction**: Each webhook event type needs its own handler with
duplicated parsing/upsert logic.

### Proposal 4: SLA Compliance Dashboard

**Impact**: None. SLA data (`sla_due_at`, `first_detected_at`, `fixed_at`) is set
during upsert, which all providers flow through. Dashboard queries aggregate
across sources transparently.

---

## Implementation Order

### Phase 1: Abstraction Foundation (2-3 days)

1. Create `providers/types.ts` with `SecuritySourceProvider` interface
2. Create `providers/registry.ts` with singleton registry
3. Move Dependabot code into `providers/dependabot/` (api, parser, permissions, types)
4. Implement `DependabotProvider` as first provider
5. Run migration: rename `dependabot_html_url` → `source_url`, add source index
6. Refactor `sync-service.ts` to use registry
7. Refactor router `dismissFinding` to use registry
8. Update all `dependabot_html_url` references → `source_url`
9. Verify all existing tests pass

### Phase 2: CodeQL Provider (3-4 days, follows immediately)

1. Create `providers/code-scanning/` with api, parser, types
2. Implement `CodeScanningProvider`
3. Register provider — sync and dismiss work automatically
4. Tune triage prompt for code-level findings (vs. dependency-level)
5. Add UI source filter badge

### Phase 3: Webhook Support (2-3 days, can parallel with Phase 2)

1. Add `handleWebhookEvent()` to Dependabot and CodeQL providers
2. Add `dependabot_alert` and `code_scanning_alert` routing to webhook-handler.ts
3. Slack notification trigger on high/critical finding upsert
4. Config extension: `slack_notifications_enabled`, `slack_channel_id`,
   `notification_severity_threshold`

### Future Phases

- **Snyk**: New provider with `platform: 'snyk'`. Requires a Snyk entry in
  `platform_integrations`. The provider interface handles the different auth
  model (API token vs. GitHub App installation token) via `checkPermissions()`.
- **Vanta**: Same pattern. Vanta's API is compliance-focused, so the parser
  would need to map compliance findings to the `ParsedSecurityFinding` format —
  potentially with a new severity mapping.

---

## What Does NOT Change

The following systems remain completely untouched:

- **Triage service** (`triage-service.ts`) — operates on `SecurityFinding`, source-agnostic
- **Analysis service** (`analysis-service.ts`) — operates on `SecurityFinding`, source-agnostic
- **Extraction service** (`extraction-service.ts`) — operates on `SecurityFinding`, source-agnostic
- **Auto-dismiss service** (`auto-dismiss-service.ts`) — operates on `SecurityFindingAnalysis`, source-agnostic
- **DB operations** (`security-findings.ts`, `security-analysis.ts`) — source-agnostic by design
- **Cron job routes** — they call `runFullSync()` and `cleanupStaleAnalyses()`, both source-agnostic
- **All UI components** — they render `SecurityFinding` records, unaware of source
  (exception: `dependabot_html_url` references need updating to `source_url`, a find-and-replace)
- **SLA calculation** — severity-based, not source-based
- **Config system** — per-owner, not per-source

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Increased alert volume from multiple sources | High | Existing triage pipeline handles noise reduction. Per-source enable/disable in config. |
| Provider API rate limiting | Medium | Each provider manages its own rate limiting internally. Cron interval unchanged. |
| Migration breaks `dependabot_html_url` references | Low | Grep-auditable, limited to ~6 files in the security-agent module + UI components. |
| Provider registration order affecting behavior | Low | Registry is a map, not a list. Order doesn't matter for sync (all providers run). |
| Non-GitHub providers need different auth models | Expected | `ProviderContext` includes the full `PlatformIntegration` — each provider extracts what it needs. Snyk uses API tokens, Vanta uses OAuth, GitHub uses installation tokens. |

---

## Success Criteria

After Phase 1, the following must be true:

1. `runFullSync()` uses the registry — no Dependabot-specific code in sync-service.ts
2. `dismissFinding` uses the registry — no `if (source === 'dependabot')` in the router
3. All existing tests pass with zero behavior change
4. Adding a new provider requires zero changes outside the `providers/` directory
   (except webhook routing, which is a one-line addition per event type)
