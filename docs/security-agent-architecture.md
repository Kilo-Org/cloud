# Security Agent — Architectural Diagram

## High-Level System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    EXTERNAL SYSTEMS                                     │
│                                                                                         │
│  ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐       │
│  │     GitHub API        │    │    LLM Proxy          │    │    Cloud Agent       │       │
│  │  ┌────────────────┐   │    │  (OpenAI-compatible)  │    │  (Sandbox Sessions)  │       │
│  │  │  Dependabot     │   │    │                      │    │                      │       │
│  │  │  Alerts API     │   │    │  • Claude Opus 4.6   │    │  • Clones repos      │       │
│  │  │                 │   │    │  • Claude Opus 4.5   │    │  • Searches codebase │       │
│  │  │  • List alerts  │   │    │  • Claude Sonnet 4.5 │    │  • Analyzes code     │       │
│  │  │  • Get alert    │   │    │  • Grok Code Fast 1  │    │  • Returns markdown  │       │
│  │  │  • Dismiss alert│   │    │                      │    │                      │       │
│  │  └────────────────┘   │    └──────────┬───────────┘    └──────────┬───────────┘       │
│  └──────────┬───────────┘               │                           │                   │
│             │                            │                           │                   │
└─────────────┼────────────────────────────┼───────────────────────────┼───────────────────┘
              │                            │                           │
              │ Octokit REST               │ Chat Completions          │ Session Stream
              │ (installation token)       │ (function calling)        │ (SSE events)
              │                            │                           │
┌─────────────┼────────────────────────────┼───────────────────────────┼───────────────────┐
│             ▼                            ▼                           ▼                   │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              SERVICE LAYER                                         │ │
│  │                                                                                    │ │
│  │  ┌─────────────────┐   ┌──────────────────────────────────────────────────────┐    │ │
│  │  │  Sync Service    │   │              Analysis Service (Orchestrator)         │    │ │
│  │  │                  │   │                                                      │    │ │
│  │  │  sync-service.ts │   │  analysis-service.ts                                │    │ │
│  │  │  ─────────────── │   │  ────────────────────                               │    │ │
│  │  │                  │   │                                                      │    │ │
│  │  │  • syncForRepo() │   │  startSecurityAnalysis()                            │    │ │
│  │  │  • syncAllRepos()│   │        │                                            │    │ │
│  │  │  • runFullSync() │   │        ▼                                            │    │ │
│  │  │  • getEnabled    │   │  ┌───────────────┐  always   ┌───────────────────┐  │    │ │
│  │  │    Configs()     │   │  │  TIER 1        │─────────▶│ triage-service.ts │  │    │ │
│  │  │                  │   │  │  Quick Triage  │          │                   │  │    │ │
│  │  │  Fetches all     │   │  └───────┬───────┘          │ • LLM call with   │  │    │ │
│  │  │  Dependabot      │   │          │                   │   function calling│  │    │ │
│  │  │  alerts, parses  │   │          │ needsSandbox?     │ • Metadata only   │  │    │ │
│  │  │  them, upserts   │   │          │ or forceSandbox?  │ • Returns: action,│  │    │ │
│  │  │  into DB with    │   │          │                   │   confidence,     │  │    │ │
│  │  │  SLA dates       │   │    ┌─────┴─────┐            │   reasoning       │  │    │ │
│  │  │                  │   │    │           │             └───────────────────┘  │    │ │
│  │  │                  │   │   YES          NO                                   │    │ │
│  │  │                  │   │    │           │                                     │    │ │
│  │  │                  │   │    ▼           ▼                                     │    │ │
│  │  │                  │   │  ┌──────────┐  Save triage ──▶ Auto-Dismiss?        │    │ │
│  │  │                  │   │  │ TIER 2    │                                      │    │ │
│  │  │                  │   │  │ Sandbox   │  Cloud Agent session                 │    │ │
│  │  │                  │   │  │ Analysis  │  with full repo access               │    │ │
│  │  │                  │   │  │           │  (background stream)                 │    │ │
│  │  │                  │   │  └─────┬────┘                                       │    │ │
│  │  │                  │   │        │                                             │    │ │
│  │  │                  │   │        ▼                                             │    │ │
│  │  │                  │   │  ┌───────────────┐          ┌─────────────────────┐  │    │ │
│  │  │                  │   │  │  TIER 3        │─────────▶│extraction-service.ts│ │    │ │
│  │  │                  │   │  │  Extraction    │          │                     │ │    │ │
│  │  │                  │   │  └───────┬───────┘          │ • LLM call with     │ │    │ │
│  │  │                  │   │          │                   │   function calling  │ │    │ │
│  │  │                  │   │          ▼                   │ • Parses raw MD to  │ │    │ │
│  │  │                  │   │   Save analysis              │   structured fields│ │    │ │
│  │  │                  │   │   + Auto-Dismiss?            │ • Returns:         │ │    │ │
│  │  │                  │   │                              │   isExploitable,   │ │    │ │
│  │  │                  │   │                              │   usageLocations,  │ │    │ │
│  │  │                  │   │                              │   suggestedFix,    │ │    │ │
│  │  │                  │   │                              │   suggestedAction  │ │    │ │
│  │  │                  │   │                              └─────────────────────┘ │    │ │
│  │  └─────────────────┘   └──────────────────────────────────────────────────────┘    │ │
│  │                                                                                    │ │
│  │  ┌───────────────────────────────────────────────────────────────────────────────┐ │ │
│  │  │                        Auto-Dismiss Service                                   │ │ │
│  │  │  auto-dismiss-service.ts                                                      │ │ │
│  │  │                                                                               │ │ │
│  │  │  maybeAutoDismissAnalysis()                                                   │ │ │
│  │  │                                                                               │ │ │
│  │  │  Priority 1: sandbox isExploitable === false  ──▶  Dismiss (no threshold)     │ │ │
│  │  │  Priority 2: triage suggestedAction === 'dismiss' ──▶ Check confidence vs     │ │ │
│  │  │              configured threshold (high/medium/low)                            │ │ │
│  │  │                                                                               │ │ │
│  │  │  autoDismissEligibleFindings()  ──  Bulk dismiss for retroactive processing   │ │ │
│  │  │  countEligibleForAutoDismiss()  ──  Preview count for UI                      │ │ │
│  │  └───────────────────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              GITHUB INTEGRATION LAYER                              │ │
│  │                                                                                    │ │
│  │  dependabot-api.ts                        permissions.ts                           │ │
│  │  ─────────────────                        ──────────────                           │ │
│  │  • fetchAllDependabotAlerts()             • hasSecurityReviewPermissions()         │ │
│  │  • fetchOpenDependabotAlerts()            • checkSecurityReviewPermissions()       │ │
│  │  • fetchDependabotAlert()                 • Required: vulnerability_alerts         │ │
│  │  • dismissDependabotAlert()                 (read or write)                        │ │
│  │  • isDependabotEnabled()                                                           │ │
│  │  • Uses installation tokens via Octokit                                            │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              DATA ACCESS LAYER                                     │ │
│  │                                                                                    │ │
│  │  security-findings.ts            security-analysis.ts        security-config.ts    │ │
│  │  ────────────────────            ──────────────────          ────────────────────   │ │
│  │  • upsertSecurityFinding()       • updateAnalysisStatus()   • getSecurityAgent     │ │
│  │  • getSecurityFindingById()      • cleanupStaleAnalyses()     Config()             │ │
│  │  • listSecurityFindings()                                   • Wraps agent_configs  │ │
│  │  • getSecurityFindingStats()                                  table                │ │
│  │  • updateSecurityFinding                                                           │ │
│  │    Status()                                                                        │ │
│  │  • deleteFindingsBy                                                                │ │
│  │    Repository()                                                                    │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                           │                                             │
│                                           ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              DATABASE (PostgreSQL)                                 │ │
│  │                                                                                    │ │
│  │  security_findings                              agent_configs                      │ │
│  │  ──────────────────                             ─────────────                      │ │
│  │  • id (uuid)                                    • agent_type = 'security_scan'     │ │
│  │  • owned_by_organization_id | owned_by_user_id  • is_enabled                       │ │
│  │  • source (dependabot | pnpm_audit | github_issue) • config (JSONB)               │ │
│  │  • severity (critical | high | medium | low)    • owned_by_organization_id         │ │
│  │  • status (open | fixed | ignored)              • owned_by_user_id                 │ │
│  │  • analysis_status (pending | running |                                            │ │
│  │    completed | failed)                          platform_integrations              │ │
│  │  • analysis (JSONB → SecurityFindingAnalysis)   ─────────────────────              │ │
│  │  • session_id, cli_session_id                   • platform = 'github'              │ │
│  │  • sla_due_at                                   • platform_installation_id         │ │
│  │  • package_name, package_ecosystem              • permissions (JSONB)              │ │
│  │  • ghsa_id, cve_id, cvss_score, cwe_ids         • repositories (JSONB)            │ │
│  │  • raw_data (JSONB)                                                                │ │
│  │  • dependabot_html_url                          R2 Blob Storage                   │ │
│  │  • dependency_scope (dev | runtime)             ────────────────                   │ │
│  │  • vulnerable_version_range                     • CLI session ui_messages          │ │
│  │  • patched_version                              • Analysis output blobs            │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              API LAYER (tRPC Routers)                              │ │
│  │                                                                                    │ │
│  │  security-agent-router.ts (personal)      org-security-agent-router.ts (org)       │ │
│  │  ────────────────────────────────         ──────────────────────────────            │ │
│  │  ~15 endpoints each:                                                               │ │
│  │                                                                                    │ │
│  │  Config:    getConfig, saveConfig, setEnabled, getRepositories                     │ │
│  │  Findings:  listFindings, getFinding, getStats, getLastSyncTime, dismissFinding    │ │
│  │  Sync:      triggerSync                                                            │ │
│  │  Analysis:  startAnalysis, getAnalysis, listAnalysisJobs                           │ │
│  │  Maint:     getOrphanedRepositories, deleteFindingsByRepository,                   │ │
│  │             autoDismissEligible                                                    │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                           │                                             │
│                                           ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              UI LAYER (React / Next.js)                            │ │
│  │                                                                                    │ │
│  │  Pages:     SecurityAgentPageClient.tsx                                            │ │
│  │  Config:    SecurityConfigForm.tsx                                                 │ │
│  │  Lists:     SecurityFindingsCard.tsx, AnalysisJobsCard.tsx                         │ │
│  │  Details:   FindingDetailDialog.tsx, DismissFindingDialog.tsx                      │ │
│  │  Badges:    SeverityBadge, ExploitabilityBadge, AnalysisStatusBadge               │ │
│  │  Filters:   RepositoryFilter.tsx                                                   │ │
│  │  Utility:   MarkdownProse.tsx                                                      │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                              CRON JOBS (Vercel Cron)                               │ │
│  │                                                                                    │ │
│  │  sync-security-alerts     Every 6 hours     Calls runFullSync() for all enabled    │ │
│  │  (route.ts)               ──────────────▶   configs. Fetches Dependabot alerts     │ │
│  │                                             and upserts findings into DB.           │ │
│  │                                                                                    │ │
│  │  cleanup-stale-analyses   Every 15 min      Marks analyses stuck in 'running'      │ │
│  │  (route.ts)               ──────────────▶   for >30 min as 'failed'.               │ │
│  └────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                         │
│                                    APPLICATION                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Analysis Pipeline Flow

```
                    ┌──────────────────┐
                    │  Security Finding │
                    │  (from DB)        │
                    └────────┬─────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │     TIER 1: QUICK TRIAGE     │
              │                              │
              │  Direct LLM call via proxy   │
              │  Input: vulnerability metadata│
              │  No repo access              │
              │                              │
              │  Output:                     │
              │  • needsSandboxAnalysis: bool │
              │  • suggestedAction:          │
              │    dismiss | analyze | review │
              │  • confidence: high|med|low  │
              └──────────────┬───────────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
            needsSandbox=true    needsSandbox=false
            or forceSandbox      (triage-only)
                    │                 │
                    │                 ▼
                    │     ┌───────────────────────┐
                    │     │  Save triage result    │
                    │     │  Mark: completed       │
                    │     │                        │
                    │     │  IF auto-dismiss ON    │
                    │     │  AND action=dismiss    │
                    │     │  AND confidence ≥      │
                    │     │    threshold:           │
                    │     │  → Auto-dismiss         │
                    │     └───────────────────────┘
                    │
                    ▼
     ┌──────────────────────────────┐
     │   TIER 2: SANDBOX ANALYSIS   │
     │                              │
     │  Cloud Agent session         │
     │  • Clones repository         │
     │  • Searches for imports      │
     │  • Analyzes usage patterns   │
     │  • Checks code paths         │
     │  • Runs in background (SSE)  │
     │                              │
     │  Output: raw markdown report │
     └──────────────┬───────────────┘
                    │
                    │  Stream completes →
                    │  Fetch result from R2
                    │
                    ▼
     ┌──────────────────────────────┐
     │   TIER 3: EXTRACTION         │
     │                              │
     │  Direct LLM call via proxy   │
     │  Input: raw markdown + vuln  │
     │    metadata                  │
     │                              │
     │  Output (structured):        │
     │  • isExploitable: bool|unk   │
     │  • exploitabilityReasoning   │
     │  • usageLocations: string[]  │
     │  • suggestedFix: string      │
     │  • suggestedAction:          │
     │    dismiss|open_pr|review|   │
     │    monitor                   │
     │  • summary: string           │
     └──────────────┬───────────────┘
                    │
                    ▼
     ┌──────────────────────────────┐
     │  FINALIZATION                │
     │                              │
     │  • Save structured analysis  │
     │  • IF isExploitable=false    │
     │    AND auto-dismiss ON:      │
     │    → Auto-dismiss finding    │
     └──────────────────────────────┘
```

## Auto-Dismiss Decision Tree

```
maybeAutoDismissAnalysis(finding, analysis)
│
├── auto_dismiss_enabled === false?  ──▶  SKIP (return)
│
├── PRIORITY 1: Sandbox result exists?
│   └── sandboxAnalysis.isExploitable === false?
│       └── YES ──▶  DISMISS  (reason: "auto-sandbox", no threshold check)
│
└── PRIORITY 2: Triage suggests dismiss?
    └── triage.suggestedAction === 'dismiss'?
        └── Check confidence vs threshold:
            │
            ├── threshold='high'   ──▶  Only if confidence='high'
            ├── threshold='medium' ──▶  If confidence='high' OR 'medium'
            └── threshold='low'    ──▶  Always dismiss
                │
                └── Meets threshold? ──▶  DISMISS  (reason: "auto-triage")
```

## Data Sync Flow

```
Vercel Cron (every 6h)                    Manual Trigger (UI)
        │                                        │
        ▼                                        ▼
  runFullSync()                           triggerSync (tRPC)
        │                                        │
        ▼                                        │
  getEnabledSecurityReviewConfigs()               │
        │                                        │
        │  For each enabled config:              │
        ▼                                        ▼
  syncAllReposForOwner()  ◀──────────────────────┘
        │
        │  For each repository:
        ▼
  syncDependabotAlertsForRepo()
        │
        ├──▶  fetchAllDependabotAlerts()  ──▶  GitHub Dependabot API
        │         (paginated, all states)
        │
        ├──▶  parseDependabotAlerts()  ──▶  Convert to ParsedSecurityFinding[]
        │
        ├──▶  getSecurityAgentConfig()  ──▶  Get SLA config
        │
        └──▶  upsertSecurityFinding()  ──▶  Insert/update in DB with SLA dates
                  (for each finding)
```

## Configuration

```
SecurityAgentConfig (stored in agent_configs.config JSONB)
├── SLA Days
│   ├── sla_critical_days: 15   (default)
│   ├── sla_high_days:     30   (default)
│   ├── sla_medium_days:   45   (default)
│   └── sla_low_days:      90   (default)
├── Sync
│   ├── auto_sync_enabled: true   (default)
│   ├── repository_selection_mode: 'all' | 'selected'
│   └── selected_repository_ids:  number[]  (when mode='selected')
├── Model
│   └── model_slug: 'anthropic/claude-opus-4.6'  (default)
└── Auto-Dismiss
    ├── auto_dismiss_enabled: false   (default — OFF)
    └── auto_dismiss_confidence_threshold: 'high' | 'medium' | 'low'
```

## File Map

```
src/lib/security-agent/
├── core/
│   ├── types.ts              Type definitions, enums, helper functions
│   ├── constants.ts          Model list, default config
│   └── schemas.ts            Zod validators for API input
├── db/
│   ├── security-findings.ts  CRUD for security_findings table
│   ├── security-analysis.ts  Analysis status updates, stale cleanup
│   └── security-config.ts    Config read/write wrapper
├── github/
│   ├── dependabot-api.ts     GitHub Dependabot REST API client
│   └── permissions.ts        Permission checking for GitHub App
├── parsers/
│   ├── dependabot-parser.ts  Converts raw alerts to internal format
│   └── dependabot-parser.test.ts
└── services/
    ├── analysis-service.ts   Three-tier analysis orchestrator
    ├── triage-service.ts     Tier 1: quick LLM triage
    ├── extraction-service.ts Tier 3: structured data extraction
    ├── auto-dismiss-service.ts  Auto-dismiss logic
    ├── sync-service.ts       Dependabot sync orchestration
    └── triage-service.test.ts

src/routers/
├── security-agent-router.ts                          Personal user API
└── organizations/organization-security-agent-router.ts  Organization API

src/app/api/cron/
├── sync-security-alerts/route.ts      Every 6h sync
└── cleanup-stale-analyses/route.ts    Every 15m cleanup
```
