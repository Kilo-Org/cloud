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

export const SecurityFindingSource = {
  DEPENDABOT: 'dependabot',
  PNPM_AUDIT: 'pnpm_audit',
  GITHUB_ISSUE: 'github_issue',
} as const;

export type SecurityFindingSource =
  (typeof SecurityFindingSource)[keyof typeof SecurityFindingSource];

export const SecurityFindingStatus = {
  OPEN: 'open',
  FIXED: 'fixed',
  IGNORED: 'ignored',
} as const;

export type SecurityFindingStatus =
  (typeof SecurityFindingStatus)[keyof typeof SecurityFindingStatus];

export const SecurityFindingAnalysisStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type SecurityFindingAnalysisStatus =
  (typeof SecurityFindingAnalysisStatus)[keyof typeof SecurityFindingAnalysisStatus];

export type AnalysisMode = 'auto' | 'shallow' | 'deep';

export type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';

export const SecurityAgentConfigSchema = z
  .object({
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
    analysis_mode: z.enum(['auto', 'shallow', 'deep']).default('auto'),
    auto_dismiss_enabled: z.boolean().default(false),
    auto_dismiss_confidence_threshold: z.enum(['high', 'medium', 'low']).default('high'),
    auto_analysis_enabled: z.boolean().default(false),
    auto_analysis_min_severity: z.enum(['critical', 'high', 'medium', 'all']).default('high'),
    auto_analysis_include_existing: z.boolean().default(false),
  })
  .passthrough();

export type SecurityAgentConfig = z.infer<typeof SecurityAgentConfigSchema>;

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

export function calculateSlaDueAt(firstDetectedAt: Date | string, slaDays: number): Date {
  const date = typeof firstDetectedAt === 'string' ? new Date(firstDetectedAt) : firstDetectedAt;
  const dueAt = new Date(date);
  dueAt.setDate(dueAt.getDate() + slaDays);
  return dueAt;
}

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

export type SecurityReviewOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

export type SyncResult = {
  synced: number;
  created: number;
  updated: number;
  errors: number;
  /** Repos where Dependabot alerts are permanently disabled (safe to skip) */
  skipped: number;
  /** Repos that returned 404 or are access-blocked (deleted/transferred/inaccessible) */
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
