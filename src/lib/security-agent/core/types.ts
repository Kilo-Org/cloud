import * as z from 'zod';
export {
  DependabotAlertState,
  SecuritySeverity,
  SandboxSuggestedAction,
} from '@kilocode/db/schema-types';
export type {
  DependabotAlertRaw,
  SecurityFindingTriage,
  SecurityFindingSandboxAnalysis,
  SecurityFindingAnalysis,
} from '@kilocode/db/schema-types';
import { DependabotAlertState, SecuritySeverity } from '@kilocode/db/schema-types';
import type {
  DependabotAlertRaw,
  DependabotAlertState as DependabotAlertStateType,
} from '@kilocode/db/schema-types';

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
 * Analysis mode for the security agent pipeline:
 * - auto: triage first, sandbox only if triage recommends it
 * - shallow: triage only, never runs sandbox
 * - deep: always force sandbox analysis
 */
export type AnalysisMode = 'auto' | 'shallow' | 'deep';

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
  triage_model_slug: z.string().optional(),
  analysis_model_slug: z.string().optional(),
  // Analysis mode: auto (default), shallow (triage only), deep (always sandbox)
  analysis_mode: z.enum(['auto', 'shallow', 'deep']).default('auto'),
  // Auto-dismiss configuration (off by default)
  auto_dismiss_enabled: z.boolean().default(false),
  auto_dismiss_confidence_threshold: z.enum(['high', 'medium', 'low']).default('high'),
});

export type SecurityAgentConfig = z.infer<typeof SecurityAgentConfigSchema>;

/**
 * Map Dependabot state to our internal status
 */
export function mapDependabotStateToStatus(state: DependabotAlertStateType): SecurityFindingStatus {
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
export function getSlaForSeverity(
  config: SecurityAgentConfig,
  severity: (typeof SecuritySeverity)[keyof typeof SecuritySeverity]
): number {
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
 * Parsed security finding ready for database insertion
 */
export type ParsedSecurityFinding = {
  source: SecurityFindingSource;
  source_id: string;
  severity: (typeof SecuritySeverity)[keyof typeof SecuritySeverity];
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
  cwe_ids: string[] | null;
  cvss_score: number | null;
  dependency_scope: 'development' | 'runtime' | null;
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
  /** Repos that returned 404 from GitHub (deleted/transferred) */
  staleRepos: string[];
};

/**
 * Legacy analysis format (for backwards compatibility with existing data)
 * @deprecated Use SecurityFindingAnalysis with triage field instead
 */
export type SecurityFindingAnalysisLegacy = {
  rawMarkdown: string;
  analyzedAt: string;
  modelUsed?: string;
};
