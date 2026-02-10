import * as z from 'zod';

/**
 * Security finding source types
 */
export const SecurityFindingSource = {
  DEPENDABOT: 'dependabot',
  PNPM_AUDIT: 'pnpm_audit',
  GITHUB_ISSUE: 'github_issue',
} as const;

export type SecurityFindingSource =
  (typeof SecurityFindingSource)[keyof typeof SecurityFindingSource];

/**
 * Security finding severity levels
 */
export const SecuritySeverity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export type SecuritySeverity = (typeof SecuritySeverity)[keyof typeof SecuritySeverity];

/**
 * Security finding status
 */
export const SecurityFindingStatus = {
  OPEN: 'open',
  FIXED: 'fixed',
  IGNORED: 'ignored',
} as const;

export type SecurityFindingStatus =
  (typeof SecurityFindingStatus)[keyof typeof SecurityFindingStatus];

/**
 * Security finding analysis status (for agent workflow)
 */
export const SecurityFindingAnalysisStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SecurityFindingAnalysisStatus =
  (typeof SecurityFindingAnalysisStatus)[keyof typeof SecurityFindingAnalysisStatus];

/**
 * Zod schema for SecurityAgentConfig
 */
export const SecurityAgentConfigSchema = z.object({
  sla_critical_days: z.number().int().positive().default(15),
  sla_high_days: z.number().int().positive().default(30),
  sla_medium_days: z.number().int().positive().default(45),
  sla_low_days: z.number().int().positive().default(90),
  auto_sync_enabled: z.boolean().default(true),
  repository_selection_mode: z.enum(['all', 'selected']).default('all'),
  selected_repository_ids: z.array(z.number()).optional(),
  model_slug: z.string().optional(),
  // Auto-dismiss configuration (off by default)
  auto_dismiss_enabled: z.boolean().default(false),
  auto_dismiss_confidence_threshold: z.enum(['high', 'medium', 'low']).default('high'),
});

export type SecurityAgentConfig = z.infer<typeof SecurityAgentConfigSchema>;

/**
 * Dependabot alert state from GitHub API
 */
export const DependabotAlertState = {
  OPEN: 'open',
  FIXED: 'fixed',
  DISMISSED: 'dismissed',
  AUTO_DISMISSED: 'auto_dismissed',
} as const;

export type DependabotAlertState = (typeof DependabotAlertState)[keyof typeof DependabotAlertState];

/**
 * Map Dependabot state to our internal status
 */
export function mapDependabotStateToStatus(state: DependabotAlertState): SecurityFindingStatus {
  switch (state) {
    case DependabotAlertState.OPEN:
      return SecurityFindingStatus.OPEN;
    case DependabotAlertState.FIXED:
      return SecurityFindingStatus.FIXED;
    case DependabotAlertState.DISMISSED:
    case DependabotAlertState.AUTO_DISMISSED:
      return SecurityFindingStatus.IGNORED;
    default:
      return SecurityFindingStatus.OPEN;
  }
}

/**
 * Get SLA days for a given severity
 */
export function getSlaForSeverity(config: SecurityAgentConfig, severity: SecuritySeverity): number {
  switch (severity) {
    case SecuritySeverity.CRITICAL:
      return config.sla_critical_days;
    case SecuritySeverity.HIGH:
      return config.sla_high_days;
    case SecuritySeverity.MEDIUM:
      return config.sla_medium_days;
    case SecuritySeverity.LOW:
      return config.sla_low_days;
    default:
      return config.sla_low_days;
  }
}

/**
 * Calculate SLA due date from first detected date and SLA days
 */
export function calculateSlaDueAt(firstDetectedAt: Date | string, slaDays: number): Date {
  const date = typeof firstDetectedAt === 'string' ? new Date(firstDetectedAt) : firstDetectedAt;
  const dueAt = new Date(date);
  dueAt.setDate(dueAt.getDate() + slaDays);
  return dueAt;
}

/**
 * Raw Dependabot alert from GitHub API
 */
export type DependabotAlertRaw = {
  number: number;
  state: DependabotAlertState;
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifest_path: string;
    scope: 'development' | 'runtime';
  };
  security_advisory: {
    ghsa_id: string;
    cve_id: string | null;
    summary: string;
    description: string;
    severity: SecuritySeverity;
    cvss?: {
      score: number;
      vector_string: string;
    };
    cwes?: Array<{
      cwe_id: string;
      name: string;
    }>;
  };
  security_vulnerability: {
    vulnerable_version_range: string;
    first_patched_version?: {
      identifier: string;
    };
  };
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_by?: {
    login: string;
  } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  auto_dismissed_at?: string | null;
  html_url: string;
  url: string;
};

/**
 * Parsed security finding ready for database insertion
 */
export type ParsedSecurityFinding = {
  source: SecurityFindingSource;
  source_id: string;
  severity: SecuritySeverity;
  ghsa_id: string | null;
  cve_id: string | null;
  package_name: string;
  package_ecosystem: string;
  vulnerable_version_range: string | null;
  patched_version: string | null;
  manifest_path: string | null;
  title: string;
  description: string | null;
  status: SecurityFindingStatus;
  ignored_reason: string | null;
  ignored_by: string | null;
  fixed_at: string | null;
  dependabot_html_url: string | null;
  first_detected_at: string;
  raw_data: DependabotAlertRaw;
  // Additional metadata (denormalized from raw_data for queries)
  cwe_ids: string[] | null;
  cvss_score: number | null;
  dependency_scope: 'development' | 'runtime' | null;
};

/**
 * Tier 1 triage result (from metadata analysis via direct LLM call)
 * Quick analysis without repo access to filter noise before expensive sandbox analysis.
 */
export type SecurityFindingTriage = {
  /** Whether sandbox analysis is needed for deeper investigation */
  needsSandboxAnalysis: boolean;
  /** Reasoning for the sandbox decision */
  needsSandboxReasoning: string;
  /** Suggested action based on triage */
  suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
  /** Confidence level in the triage decision */
  confidence: 'high' | 'medium' | 'low';
  /** When the triage was performed */
  triageAt: string;
};

/**
 * Suggested action from Tier 3 sandbox analysis
 */
export const SandboxSuggestedAction = {
  /** Dismiss the finding - not exploitable in this codebase */
  DISMISS: 'dismiss',
  /** Open a PR to fix the vulnerability - exploitable with clear fix */
  OPEN_PR: 'open_pr',
  /** Needs human review - complex situation or unclear fix */
  MANUAL_REVIEW: 'manual_review',
  /** Keep open but low priority - exploitable but low risk */
  MONITOR: 'monitor',
} as const;

export type SandboxSuggestedAction =
  (typeof SandboxSuggestedAction)[keyof typeof SandboxSuggestedAction];

/**
 * Tier 2 sandbox analysis result (from cloud agent + Tier 3 extraction)
 * Deep analysis with repo access to determine exploitability.
 */
export type SecurityFindingSandboxAnalysis = {
  /** Whether the vulnerability is exploitable in this codebase */
  isExploitable: boolean | 'unknown';
  /** Detailed reasoning for the exploitability determination */
  exploitabilityReasoning: string;
  /** File paths where the vulnerable package is used */
  usageLocations: string[];
  /** Specific fix recommendation */
  suggestedFix: string;
  /** Suggested next action based on analysis */
  suggestedAction: SandboxSuggestedAction;
  /** Brief summary suitable for display in a dashboard */
  summary: string;
  /** Raw markdown output from the agent (for reference) */
  rawMarkdown: string;
  /** When the sandbox analysis was performed */
  analysisAt: string;
  /** Model used for sandbox analysis */
  modelUsed?: string;
};

/**
 * Full analysis result for a security finding.
 * Stored in the `analysis` JSONB field of security_findings.
 *
 * Two-tier architecture:
 * - `triage`: Present after Tier 1 quick triage (optional for backwards compatibility with legacy data)
 * - `sandboxAnalysis`: Only present if Tier 2 sandbox analysis was run AND MCP tool was called
 * - `rawMarkdown`: Present in legacy format OR as fallback if sandbox ran but MCP tool was not called
 */
export type SecurityFindingAnalysis = {
  /** Tier 1 triage result (optional for backwards compatibility with legacy data) */
  triage?: SecurityFindingTriage;
  /** Tier 2 sandbox analysis result (only if sandbox was run and MCP tool was called) */
  sandboxAnalysis?: SecurityFindingSandboxAnalysis;
  /** Raw markdown - present in legacy format or as fallback if sandbox ran but MCP tool was not called */
  rawMarkdown?: string;
  /** When the analysis was last updated */
  analyzedAt: string;
  /** Model used for analysis */
  modelUsed?: string;
  /** User ID who triggered the analysis (for audit tracking) */
  triggeredByUserId?: string;
  /** Correlation ID for tracing across triage → sandbox → extraction → auto-dismiss */
  correlationId?: string;
};

/**
 * Legacy analysis format (for backwards compatibility with existing data)
 * @deprecated Use SecurityFindingAnalysis with triage field instead
 */
export type SecurityFindingAnalysisLegacy = {
  /** Raw markdown output from the LLM analysis */
  rawMarkdown: string;
  /** When the analysis was performed */
  analyzedAt: string;
  /** Model used for analysis (e.g., 'anthropic/claude-sonnet-4') */
  modelUsed?: string;
};

/**
 * Owner type for security reviews (org or user)
 */
export type SecurityReviewOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

/**
 * Sync result type
 */
export type SyncResult = {
  synced: number;
  created: number;
  updated: number;
  errors: number;
};
