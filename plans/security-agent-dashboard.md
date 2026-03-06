# Implementation Plan: Security Agent Dashboard

A dedicated dashboard for the Security Agent feature, giving security/compliance leads and engineering managers a quick overview of SLA compliance, vulnerability severity, analysis coverage, and repository health.

---

## 1. Route Structure & Navigation

The existing flat `/security-agent` page is restructured into a nested route layout:

| Route                      | Content                 | Notes                                                                                 |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `/security-agent`          | **Dashboard** (default) | Redirects to `/security-agent/config` if agent is not enabled (see truth table below) |
| `/security-agent/findings` | Findings list           | Current `SecurityFindingsCard` + dialogs (extracted from existing tabs)               |
| `/security-agent/config`   | Configuration           | Current `SecurityConfigForm` + `ClearFindingsCard` (extracted from existing tabs)     |

Same structure for organizations:

| Route                                         | Content       |
| --------------------------------------------- | ------------- |
| `/organizations/[id]/security-agent`          | Org Dashboard |
| `/organizations/[id]/security-agent/findings` | Org Findings  |
| `/organizations/[id]/security-agent/config`   | Org Config    |

**Navigation:** A sub-nav at the top of a shared security-agent layout links Dashboard / Findings / Config. The current tab-based switching in `SecurityAgentPageClient` is replaced by route-based navigation.

**Conditional default:** The redirect target when navigating to `/security-agent` depends on integration and enablement state. The config API always returns defaults, so "not configured" is not a distinguishable state — use `isEnabled` from `getConfig` as the sole signal.

| GitHub integration | Agent enabled | `/security-agent` shows             |
| ------------------ | ------------- | ----------------------------------- |
| Not installed      | N/A           | Dashboard with install CTA          |
| Installed          | No            | Redirect → `/security-agent/config` |
| Installed          | Yes           | Dashboard                           |

This preserves the existing behavior where `SecurityFindingsCard` renders an install-GitHub CTA when `hasIntegration` is false, so users without an integration are never stranded on a config page that cannot help them.

---

## 2. Component Architecture

### Shared component

A single `SecurityDashboard` component parameterized by `organizationId?: string`, matching the existing `SecurityAgentPageClient` pattern. All tRPC calls route through the appropriate personal or org router based on the presence of `organizationId`.

### Shared layout

A `SecurityAgentLayout` component wraps all three sub-routes, providing:

- Page title ("Security Agent" + Beta badge)
- Sub-navigation (Dashboard / Findings / Config)
- GitHub permission/integration alerts (currently in `SecurityAgentPageClient`)

### File structure

```
src/components/security-agent/
├── SecurityAgentLayout.tsx          # Shared layout with sub-nav
├── SecurityDashboard.tsx            # Dashboard container
├── dashboard/
│   ├── SlaComplianceHero.tsx        # Hero metric: overall SLA compliance
│   ├── SeverityBreakdown.tsx        # Severity stat cards
│   ├── StatusOverview.tsx           # Open/fixed/ignored distribution chart
│   ├── AnalysisCoverage.tsx         # Analysis progress + exploitability breakdown
│   ├── MeanTimeToResolution.tsx     # MTTR by severity vs SLA targets
│   ├── OverdueFindingsTable.tsx     # Top overdue findings list
│   └── RepositoryHealthTable.tsx    # Repos ranked by risk
├── SecurityAgentPageClient.tsx      # Existing (refactored to findings-only)
├── SecurityFindingsCard.tsx         # Existing
├── ...                              # Other existing components
```

### Route files

```
src/app/(app)/security-agent/
├── layout.tsx                                    # Shared layout
├── page.tsx                                      # Dashboard (default)
├── findings/page.tsx                             # Findings page
├── config/page.tsx                               # Config page

src/app/(app)/organizations/[id]/security-agent/
├── layout.tsx                                    # Shared org layout (wraps with OrganizationByPageLayout)
├── page.tsx                                      # Org Dashboard
├── findings/page.tsx                             # Org Findings
├── config/page.tsx                               # Org Config
```

**Org layout note:** The existing org page uses `OrganizationByPageLayout` to resolve the organization and enforce access. The new org `layout.tsx` must preserve this wrapper — it resolves parameter `id` and provides the `organization` object to child routes. The `SecurityAgentLayout` component receives `organizationId` from this wrapper.

---

## 3. Dashboard Layout (Top to Bottom)

### 3a. Header

- Title: "Security Agent" + Beta badge (rendered by shared layout)
- Repository filter dropdown (filters the entire dashboard when selected)
- Last sync timestamp

### 3b. SLA Compliance Hero

The primary metric at the top of the dashboard.

- **Large central metric:** Overall SLA compliance percentage (e.g., "87% SLA Compliant")
  - **Population:** Only open findings where `sla_due_at IS NOT NULL`. Findings with a NULL `sla_due_at` (e.g., created before SLA tracking was enabled) are excluded from both numerator and denominator.
  - Formula: `(SLA-trackable open findings where sla_due_at > now()) / (SLA-trackable open findings) × 100`
  - If no SLA-trackable open findings, display "100% — No open findings with SLA"
  - If there are open findings but none have `sla_due_at`, display "N/A — No SLA data" with a hint to sync
- **Total overdue count** displayed prominently (e.g., "12 findings overdue")
- **Per-severity breakdown:**
  - Critical: X% compliant (Y of Z within SLA)
  - High: X% compliant (Y of Z within SLA)
  - Medium: X% compliant (Y of Z within SLA)
  - Low: X% compliant (Y of Z within SLA)
  - Each severity line only counts findings where `sla_due_at IS NOT NULL`
- **Drill-down:** Clicking the overdue count navigates to `/security-agent/findings?status=open&overdue=true`

### 3c. Severity Breakdown + Status Overview (Two-column grid)

**Severity Breakdown (left side):**

- 4 stat cards showing open finding counts per severity level
- Color scheme: Critical (red) / High (orange) / Medium (yellow) / Low (blue)
- Each card clickable → navigates to findings filtered by that severity

**Findings by Status (right side):**

- Donut chart or horizontal stacked bar showing open / fixed / ignored distribution
- Total count in center (if donut)
- Each segment clickable → navigates to findings filtered by that status

### 3d. Analysis Coverage

- Headline metric: "34 of 52 findings analyzed" with progress bar
  - "Analyzed" = findings where `analysis_status = 'completed'`
  - Denominator = all open findings
- Sub-breakdown of analysis outcomes, mapped to existing `OutcomeFilterSchema` values so drill-downs use the same `outcomeFilter` param already supported by `listSecurityFindings`:
  - **Exploitable** (`outcomeFilter=exploitable`): `analysis_status = 'completed'` AND `analysis->'sandboxAnalysis'->>'isExploitable' = 'true'`
  - **Not exploitable** (`outcomeFilter=not_exploitable`): `analysis_status = 'completed'` AND `analysis->'sandboxAnalysis'->>'isExploitable' = 'false'`
  - **Triage complete** (`outcomeFilter=triage_complete`): `analysis_status = 'completed'` AND triage done but no sandbox analysis yet (`suggestedAction = 'analyze_codebase'`)
  - **Safe to dismiss** (`outcomeFilter=safe_to_dismiss`): `analysis_status = 'completed'` AND `analysis->'triage'->>'suggestedAction' = 'dismiss'`
  - **Needs review** (`outcomeFilter=needs_review`): `analysis_status = 'completed'` AND `analysis->'triage'->>'suggestedAction' = 'manual_review'`
  - **Analyzing** (`outcomeFilter=analyzing`): `analysis_status IN ('pending', 'running')`
  - **Not analyzed** (`outcomeFilter=not_analyzed`): `analysis_status IS NULL`
  - **Failed** (`outcomeFilter=failed`): `analysis_status = 'failed'`
- Each segment clickable → navigates to findings page with the corresponding `outcomeFilter` value

### 3e. Mean Time to Resolution

- MTTR derived from existing `first_detected_at` and `fixed_at` timestamps
- **Population:** Only findings where `status = 'fixed'` AND `fixed_at IS NOT NULL` AND `first_detected_at IS NOT NULL`. Findings with missing timestamps are excluded.
- **Calculation:** `AVG(fixed_at - first_detected_at)` in days, grouped by severity. Use median if outliers are a concern (defer to implementation; start with avg and add `medianDays` field to the response type as `number | null`).
- Broken down by severity, compared against configured SLA targets (read from `getConfig`):
  - Critical: avg X days (SLA: Y days) — green/red indicator
  - High: avg X days (SLA: Y days)
  - Medium: avg X days (SLA: Y days)
  - Low: avg X days (SLA: Y days)
- SLA target values come from the user's config, not hardcoded defaults. Display the configured value.
- Visual indicator (color or icon) showing whether avg resolution is within or exceeding SLA
- If no fixed findings exist for a severity, show "—" instead of 0

### 3f. Overdue Findings Table

- Compact table of open findings where `sla_due_at < now()`
- Sorted by most overdue first (oldest `sla_due_at`)
- Columns: Severity | Title | Repository | Package | Days Overdue | SLA Due Date
- Limited to top 10 rows
- "View all overdue" link → findings page with overdue filter
- Each row clickable → opens finding detail dialog

### 3g. Repository Health Table

- Repos ranked by risk (most critical/overdue findings first)
- Columns: Repository | Critical | High | Medium | Low | Overdue | SLA Compliance %
- Sort order: critical count desc, then overdue count desc
- Top 10 repos shown, "View all" link for more
- Each row clickable → navigates to findings for that repo

---

## 4. Backend Changes

### New tRPC procedure: `getDashboardStats`

Added to both the personal `securityAgent` router and the org `organizations.securityAgent` router.

Returns a single payload combining all dashboard data in one round-trip to minimize client waterfalls:

```typescript
type DashboardStats = {
  sla: {
    // "total" = open findings where sla_due_at IS NOT NULL (SLA-trackable)
    overall: { total: number; withinSla: number; overdue: number };
    bySeverity: Record<Severity, { total: number; withinSla: number; overdue: number }>;
    // Count of open findings with sla_due_at IS NULL (excluded from SLA metrics)
    untrackedCount: number;
  };
  severity: Record<Severity, number>; // open finding counts by severity
  status: { open: number; fixed: number; ignored: number };
  analysis: {
    total: number; // all open findings (denominator)
    analyzed: number; // analysis_status = 'completed'
    exploitable: number; // completed + sandboxAnalysis.isExploitable = true
    notExploitable: number; // completed + sandboxAnalysis.isExploitable = false
    triageComplete: number; // completed + triage done, no sandbox yet (suggestedAction = 'analyze_codebase')
    safeToDismiss: number; // completed + triage suggestedAction = 'dismiss'
    needsReview: number; // completed + triage suggestedAction = 'manual_review'
    analyzing: number; // analysis_status IN ('pending', 'running')
    notAnalyzed: number; // analysis_status IS NULL
    failed: number; // analysis_status = 'failed'
  };
  mttr: {
    bySeverity: Record<
      Severity,
      {
        avgDays: number | null; // null if no fixed findings for that severity
        medianDays: number | null; // null if no fixed findings; optional, defer if complex
        count: number; // number of fixed findings in the calculation
        slaDays: number; // configured SLA target (from getConfig, not hardcoded)
      }
    >;
  };
  overdue: Array<{
    id: string;
    severity: Severity;
    title: string;
    repoFullName: string;
    packageName: string;
    slaDueAt: string;
    daysOverdue: number;
  }>;
  repoHealth: Array<{
    repoFullName: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
    overdue: number;
    slaCompliancePercent: number;
  }>;
};
```

### Query implementation

All data is derivable from the existing `security_findings` table:

| Data              | SQL approach                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SLA compliance    | `COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL AND sla_due_at > now())` grouped by severity. Denominator: `COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL)` |
| Severity counts   | Existing `getStats` logic (or folded into dashboard query)                                                                                                                                         |
| Status counts     | Existing `getStats` logic                                                                                                                                                                          |
| Analysis coverage | `GROUP BY analysis_status` + JSON extraction from `analysis` column for exploitability/triage outcomes. See §3d for exact mapping.                                                                 |
| MTTR              | `AVG(EXTRACT(EPOCH FROM (fixed_at - first_detected_at)) / 86400)` where `status = 'fixed' AND fixed_at IS NOT NULL AND first_detected_at IS NOT NULL`, grouped by severity                         |
| Overdue findings  | `WHERE status = 'open' AND sla_due_at IS NOT NULL AND sla_due_at < now()` ordered by `sla_due_at ASC`, limit 10                                                                                    |
| Repo health       | `GROUP BY repo_full_name`, aggregate severity counts + SLA compliance per repo                                                                                                                     |

**No new tables, cron jobs, or migrations required.** All data comes from existing columns.

### Query performance considerations

The dashboard query aggregates across potentially large result sets with JSON-path extraction. Mitigations:

- The existing `idx_security_findings_status`, `idx_security_findings_severity`, and `idx_security_findings_sla_due_at` indexes cover the primary filter predicates.
- JSON-path filters on `analysis->>'...'` are not indexed. If analysis-coverage queries become slow, add an expression index: `CREATE INDEX idx_security_findings_triage_action ON security_findings ((analysis->'triage'->>'suggestedAction')) WHERE analysis_status = 'completed'`. Defer until measured.
- The implementation should run the independent aggregations (SLA, severity, status, analysis, MTTR, overdue, repo-health) as parallel `Promise.all` queries rather than funneling through a single massive SQL statement, keeping each query simple and independently cacheable.
- Add a `console.time` / Sentry span around `getDashboardStats` in the initial implementation to establish a latency baseline.

### Optional: `repoFullName` filter param

The `getDashboardStats` procedure accepts an optional `repoFullName: string` input. When provided, all queries are scoped to that repository.

---

## 5. Filtering

- **Repository filter:** A single dropdown at the top of the dashboard (reusing the existing `RepositoryFilter` component). Selecting a repo re-fetches `getDashboardStats` with the `repoFullName` param.
- No severity/status/time-range filters on the dashboard — those live on the findings page.

---

## 6. Drill-Down Navigation

All clickable dashboard elements navigate to the findings page with query params. Parameter names **must** match the existing `ListFindingsInputSchema` fields (`status`, `severity`, `repoFullName`, `outcomeFilter`) so the findings page can apply them without a translation layer.

The one addition is `overdue=true`, a client-only URL param that the findings page interprets as `status=open` + sort by `sla_due_at ASC` (most overdue first). This requires adding `sla_due_at` sort support to `ListFindingsInputSchema` and the `listSecurityFindings` query.

| Element                              | Target                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| SLA overdue count                    | `/security-agent/findings?status=open&overdue=true`                |
| Severity card (e.g., Critical)       | `/security-agent/findings?severity=critical&status=open`           |
| Status segment (e.g., Open)          | `/security-agent/findings?status=open`                             |
| Analysis outcome (e.g., Exploitable) | `/security-agent/findings?outcomeFilter=exploitable`               |
| Overdue table row                    | `/security-agent/findings?status=open&overdue=true&findingId={id}` |
| Overdue "View all" link              | `/security-agent/findings?status=open&overdue=true`                |
| Repo health row                      | `/security-agent/findings?repoFullName=owner/repo`                 |

**Implementation notes:**

- The findings page reads URL search params on mount and seeds its filter state from them.
- `findingId` param: the findings page auto-opens the `FindingDetailDialog` for that finding on load, reusing existing dialog state wiring.
- `overdue=true` is consumed client-side only: it sets `status=open` and `sortBy=sla_due_at_asc` before the first query fires.
- Org-scoped drill-downs prefix with `/organizations/[id]/security-agent/findings?...`.

---

## 7. Technology

| Concern       | Choice                                                     | Rationale                                    |
| ------------- | ---------------------------------------------------------- | -------------------------------------------- |
| Charts        | `recharts` (v3.3.0)                                        | Already in codebase, used in 12+ admin pages |
| UI primitives | shadcn/ui `Card`, `Badge`, `Table`, `Skeleton`, `Progress` | Project standard                             |
| Data fetching | `@tanstack/react-query` via tRPC                           | Matches existing patterns                    |
| Icons         | `lucide-react`                                             | Project standard                             |
| Styling       | Tailwind CSS + `cn()` utility                              | Project standard                             |

---

## 8. Implementation Phases

### Phase 1: Route restructure

1. Create shared `SecurityAgentLayout` with sub-navigation
2. Create new route files for dashboard, findings, and config (both personal and org)
3. Org routes: wrap with `OrganizationByPageLayout` to preserve org resolution and access control
4. Extract findings and config content from `SecurityAgentPageClient` into their own route pages
5. Implement conditional redirect per §1 truth table (no integration → dashboard with CTA, installed+disabled → config, installed+enabled → dashboard)
6. Verify existing functionality is preserved after restructure

### Phase 2: Backend — `getDashboardStats` endpoint

1. Implement the `getDashboardStats` query function in `src/lib/security-agent/db/`
2. Use `Promise.all` for independent aggregations (SLA, severity, status, analysis, MTTR, overdue, repo-health)
3. Ensure all SLA queries filter on `sla_due_at IS NOT NULL`; MTTR queries filter on `fixed_at IS NOT NULL`
4. Add the tRPC procedure to both personal and org routers
5. Add the optional `repoFullName` filter parameter
6. Add input validation via Zod schema
7. Add Sentry performance span around the full handler

### Phase 3: Dashboard — SLA hero + stat cards

1. Build `SlaComplianceHero` component
2. Build `SeverityBreakdown` stat cards
3. Build `StatusOverview` chart (donut or stacked bar)
4. Wire up to `getDashboardStats` query
5. Add loading skeletons

### Phase 4: Dashboard — Analysis, MTTR, tables

1. Build `AnalysisCoverage` component with progress bar + outcome breakdown
2. Build `MeanTimeToResolution` component with severity vs SLA comparison
3. Build `OverdueFindingsTable` with drill-down links
4. Build `RepositoryHealthTable` with risk ranking

### Phase 5: Drill-down + filtering

1. Add repository filter to dashboard header
2. Extend `ListFindingsInputSchema` to support `sortBy: 'sla_due_at_asc'` for overdue sorting
3. Implement query-param-based drill-down links using existing param names (see §6)
4. Update findings page to read URL search params on mount and seed filter state
5. Handle `overdue=true` client-side param → sets `status=open` + `sortBy=sla_due_at_asc`
6. Handle `findingId` param → auto-open `FindingDetailDialog` for that finding
7. Verify all drill-down paths work end-to-end

---

## 9. Cache Invalidation & Refresh

Dashboard data must stay consistent with actions taken on other pages (dismiss, sync, config save).

- **Invalidation:** Sync, dismiss, config-save, and enable/disable mutations already call `queryClient.invalidateQueries()` broadly. The dashboard `getDashboardStats` query key will be invalidated by this pattern with no additional wiring.
- **Stale time:** Set `staleTime: 30_000` (30s) on the dashboard query to avoid re-fetching on every tab focus while keeping data reasonably fresh.
- **No auto-polling on dashboard.** The findings page polls every 5s during active analysis because it shows per-finding status updates. The dashboard shows aggregate counts where a 30s stale window is sufficient. If the user needs live data, they can navigate to findings.
- **Manual refresh:** Include a "Refresh" button in the dashboard header (consistent with the existing sync button on findings) that invalidates the `getDashboardStats` query.

---

## 10. Testing Requirements

Each phase should include tests proportional to the risk of the change:

### Phase 1 (Route restructure)

- Smoke test: verify each route renders without errors for both personal and org contexts
- Redirect logic: test all 3 states from §1 truth table (no integration, installed+disabled, installed+enabled)
- Verify that existing findings and config functionality is not regressed

### Phase 2 (Backend)

- Unit tests for `getDashboardStats` query function in `src/lib/security-agent/db/`:
  - SLA compliance with mix of NULL and non-NULL `sla_due_at` values
  - MTTR calculation with fixed findings, no fixed findings, and mixed severities
  - Analysis coverage counts matching `OutcomeFilterSchema` categories
  - Overdue findings ordering and limit
  - Repo health aggregation correctness
  - `repoFullName` filter scoping
- Router-level test: verify the procedure is callable and returns the expected shape (both personal and org)

### Phase 5 (Drill-down)

- URL param parsing: verify each param combination seeds the correct filter state
- `findingId` param: verify dialog opens for valid ID, gracefully handles missing ID
- `overdue=true` translates to correct sort and status

### Performance

- Measure `getDashboardStats` latency on a representative dataset (100+ findings across 10+ repos) and ensure it completes within 500ms

---

## 11. Open Questions

- **Empty state:** What should the dashboard show when there are zero findings (agent enabled, synced, but no vulnerabilities)? A celebratory "all clear" state vs. a minimal stats view.
- ~~**Refresh cadence:** Should the dashboard auto-poll like the findings page does during active analysis (currently every 5s), or is manual refresh sufficient?~~ **Resolved:** No auto-polling on dashboard. Use `staleTime: 30s` + manual refresh button. See §9.
- **Mobile responsiveness:** How critical is mobile layout for this dashboard? The current security agent page is desktop-focused.
