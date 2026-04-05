# Security Reviews - Phase 1 Implementation

## Overview

This module implements the first phase of the agentic security reviews feature:

1. **Dependabot API integration** (query-based) for repositories with Dependabot enabled
2. **Full alert sync** including open, fixed, and dismissed alerts

**Rationale**: Dependabot is the primary source because:

- It's already integrated with GitHub (our users' repositories)
- It provides real-time vulnerability tracking
- It's the source Vanta uses for SOC2 compliance
- Most GitHub repositories have Dependabot enabled by default

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Input Sources                               │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│   Dependabot    │   pnpm audit    │  GitHub Issues (future)         │
│   (Phase 1) ✓   │   (Future)      │                                 │
└────────┬────────┴────────┬────────┴─────────────────────────────────┘
         │                 │
         ▼                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Finding Normalization Layer                       │
│         (Convert tool-specific output to SecurityFinding)            │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Database Layer                               │
│                      security_findings table                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/lib/security-reviews/
├── README.md                 # This file
├── core/
│   └── types.ts              # TypeScript types, SLA helpers
├── db/
│   ├── security-findings.ts  # CRUD for security_findings table
│   └── security-config.ts    # Wrapper for agent_configs (SLA settings)
├── github/
│   ├── dependabot-api.ts     # Fetch Dependabot alerts from GitHub API
│   └── permissions.ts        # Check GitHub App permissions
├── parsers/
│   ├── dependabot-parser.ts  # Parse Dependabot API response
│   └── dependabot-parser.test.ts
└── services/
    └── sync-service.ts       # Orchestrate sync operations
```

---

## Key Components

### 1. Types (`core/types.ts`)

- `SecurityReviewOwner` - Owner type (user or organization)
- `SecurityReviewAgentConfig` - SLA configuration stored in `agent_configs`
- `ParsedSecurityFinding` - Normalized finding from any source
- `SyncResult` - Result of sync operations
- Helper functions: `getSlaForSeverity()`, `calculateSlaDueAt()`

### 2. Database Operations

#### `db/security-findings.ts`

- `upsertSecurityFinding()` - Insert or update a finding (upsert by source + source_id)
- `listSecurityFindings()` - Query findings with filters
- `getSecurityFindingById()` - Get single finding
- `getSecurityFindingsSummary()` - Aggregate stats by severity/status

#### `db/security-config.ts`

- `getSecurityReviewConfig()` - Get SLA config from `agent_configs`
- `upsertSecurityReviewConfig()` - Save SLA config
- `setSecurityReviewEnabled()` - Enable/disable security reviews
- `getSecurityReviewConfigWithStatus()` - Get config with enabled status

### 3. GitHub Integration

#### `github/dependabot-api.ts`

- `fetchAllDependabotAlerts()` - Fetch ALL alerts (open, fixed, dismissed) with pagination
- Uses `@octokit/rest` with installation token authentication

#### `github/permissions.ts`

- `hasSecurityReviewPermissions()` - Check if integration has `vulnerability_alerts` permission
- `getReauthorizeUrl()` - Generate URL to re-authorize GitHub App

### 4. Parsers

#### `parsers/dependabot-parser.ts`

- `parseDependabotAlert()` - Convert single Dependabot alert to `ParsedSecurityFinding`
- `parseDependabotAlerts()` - Convert array of alerts
- Maps Dependabot states to our status: `open` → `open`, `fixed` → `fixed`, `dismissed`/`auto_dismissed` → `ignored`

### 5. Sync Service (`services/sync-service.ts`)

- `syncDependabotAlertsForRepo()` - Sync alerts for a single repository
- `syncAllReposForOwner()` - Sync all repos for an owner
- `getEnabledSecurityReviewConfigs()` - Get all enabled configs with integrations
- `runFullSync()` - Full sync for all enabled configurations (used by cron)

---

## API Endpoints

### tRPC Router (`src/routers/security-reviews-router.ts`)

| Procedure             | Type     | Description                                               |
| --------------------- | -------- | --------------------------------------------------------- |
| `getPermissionStatus` | Query    | Check if GitHub App has `vulnerability_alerts` permission |
| `getConfig`           | Query    | Get SLA configuration                                     |
| `saveConfig`          | Mutation | Save SLA configuration                                    |
| `setEnabled`          | Mutation | Enable/disable security reviews                           |
| `listFindings`        | Query    | List findings with filters                                |
| `getFinding`          | Query    | Get single finding by ID                                  |
| `getStats`            | Query    | Get summary statistics                                    |
| `triggerSync`         | Mutation | **Manual trigger** to sync a specific repository          |

### Cron Job (`src/app/api/cron/sync-security-alerts/route.ts`)

- Runs every 6 hours (configured in `vercel.json`)
- Syncs all repositories for all enabled configurations
- Sends heartbeat to BetterStack monitoring

---

## Database Schema

### Table: `security_findings`

| Column                     | Type      | Description                               |
| -------------------------- | --------- | ----------------------------------------- |
| `id`                       | UUID      | Primary key                               |
| `owned_by_organization_id` | UUID      | Organization owner (nullable)             |
| `owned_by_user_id`         | TEXT      | User owner (nullable)                     |
| `platform_integration_id`  | UUID      | Reference to platform_integrations        |
| `repo_full_name`           | TEXT      | Repository full name (e.g., "owner/repo") |
| `source`                   | TEXT      | Source type: 'dependabot'                 |
| `source_id`                | TEXT      | Alert number from source                  |
| `severity`                 | TEXT      | 'critical', 'high', 'medium', 'low'       |
| `ghsa_id`                  | TEXT      | GitHub Security Advisory ID               |
| `cve_id`                   | TEXT      | CVE ID (nullable)                         |
| `package_name`             | TEXT      | Vulnerable package name                   |
| `package_ecosystem`        | TEXT      | Package ecosystem (npm, pip, etc.)        |
| `vulnerable_version_range` | TEXT      | Affected versions                         |
| `patched_version`          | TEXT      | Fixed version (nullable)                  |
| `manifest_path`            | TEXT      | Path to manifest file                     |
| `title`                    | TEXT      | Finding title                             |
| `description`              | TEXT      | Full description                          |
| `status`                   | TEXT      | 'open', 'fixed', 'ignored'                |
| `ignored_reason`           | TEXT      | Reason for dismissal                      |
| `fixed_at`                 | TIMESTAMP | When fixed                                |
| `sla_due_at`               | TIMESTAMP | SLA deadline                              |
| `dependabot_html_url`      | TEXT      | Link to Dependabot alert                  |
| `raw_data`                 | JSONB     | Original API response                     |
| `first_detected_at`        | TIMESTAMP | When first seen                           |
| `last_synced_at`           | TIMESTAMP | Last sync time                            |

**Constraints:**

- Unique on `(repo_full_name, source, source_id)` - prevents duplicates
- Check constraint: exactly one of `owned_by_organization_id` or `owned_by_user_id` must be set

---

## SLA Configuration

Default SLAs stored in `agent_configs` table with `agent_type: 'security_scan'`:

| Severity | Default SLA (days) |
| -------- | ------------------ |
| Critical | 15                 |
| High     | 30                 |
| Medium   | 45                 |
| Low      | 90                 |

---

## GitHub App Permissions

**Required permission**: `vulnerability_alerts: read`

When permission is missing:

1. UI shows "Security Reviews requires additional permissions"
2. Provides link to re-authorize: `https://github.com/apps/{app}/installations/{id}`

---

## Usage

### Manual Sync (from UI)

```typescript
// Trigger sync for a specific repository
await trpc.securityReviews.triggerSync.mutate({
  repoFullName: 'owner/repo',
});
```

### Automated Sync (cron)

The cron job at `/api/cron/sync-security-alerts` runs every 6 hours and:

1. Gets all enabled security review configurations
2. For each, syncs all repositories
3. Reports results to BetterStack

---

## State Mapping

| Dependabot State | Our Status |
| ---------------- | ---------- |
| `open`           | `open`     |
| `fixed`          | `fixed`    |
| `dismissed`      | `ignored`  |
| `auto_dismissed` | `ignored`  |

---

## Future Work

### pnpm Audit Fallback

For repositories without Dependabot:

- Create `parsers/pnpm-audit-parser.ts`
- Integrate with cloud agent to run `pnpm audit --json`
- Add `security_scans` table to track scan executions

### Webhook Integration

For real-time updates, subscribe to `dependabot_alert` webhooks:

- Add event subscription in GitHub App settings
- Add webhook handler
- Process events: `created`, `dismissed`, `fixed`, `reintroduced`, `reopened`

### LLM Analysis (Phase 2)

Add AI-powered analysis:

- Relevance assessment
- Exploitability analysis
- Suggested fixes
