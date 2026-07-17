const STATUS_FILTERS = ['open', 'fixed', 'ignored', 'closed', 'all'] as const;
const SEVERITY_FILTERS = ['all', 'critical', 'high', 'medium', 'low'] as const;
const OUTCOME_FILTERS = [
  'all',
  'not_analyzed',
  'analyzing',
  'failed',
  'exploitable',
  'not_exploitable',
  'safe_to_dismiss',
  'needs_review',
  'triage_complete',
  'fixed',
  'dismissed',
] as const;
const SORT_OPTIONS = ['severity_desc', 'severity_asc', 'sla_due_at_asc'] as const;
const STATUS_IMPLYING_OUTCOMES = new Set<SecurityOutcomeFilter>(['fixed', 'dismissed']);

export type SecurityFindingStatusFilter = (typeof STATUS_FILTERS)[number];
export type SecuritySeverityFilter = (typeof SEVERITY_FILTERS)[number];
export type SecurityOutcomeFilter = (typeof OUTCOME_FILTERS)[number];
export type SecurityFindingSortBy = (typeof SORT_OPTIONS)[number];

export type SecurityFindingFilters = {
  status: SecurityFindingStatusFilter;
  severity: SecuritySeverityFilter;
  outcome: SecurityOutcomeFilter;
  repoFullName: string | null;
  sortBy: SecurityFindingSortBy;
  overdue?: boolean;
};

export const DEFAULT_SECURITY_FINDING_FILTERS: SecurityFindingFilters = {
  status: 'open',
  severity: 'all',
  outcome: 'all',
  repoFullName: null,
  sortBy: 'severity_desc',
};

const SECURITY_FINDINGS_PAGE_SIZE = 50;

// Structural shape of the `securityAgent.listFindings` tRPC input — the
// personal and org procedures share these filter fields (the org variant
// just adds organizationId, applied by the hook layer). Matches
// apps/web/src/lib/security-agent/core/schemas.ts' ListFindingsInputSchema:
// 'all' is a UI-only sentinel this module never sends for status/severity,
// so those two fields exclude it while outcomeFilter (whose schema does
// accept 'all') keeps the full union.
export type SecurityFindingQuery = {
  sortBy: SecurityFindingSortBy;
  limit: number;
  offset: number;
  status?: Exclude<SecurityFindingStatusFilter, 'all'>;
  severity?: Exclude<SecuritySeverityFilter, 'all'>;
  outcomeFilter?: SecurityOutcomeFilter;
  repoFullName?: string;
  overdue?: boolean;
};

export function getNextSecurityFindingsOffset(
  initialOffset: number,
  loadedCount: number,
  totalCount: number
): number | undefined {
  const nextOffset = initialOffset + loadedCount;
  return nextOffset < totalCount ? nextOffset : undefined;
}

export function selectSecurityFindingStatus(
  filters: SecurityFindingFilters,
  status: SecurityFindingStatusFilter
): SecurityFindingFilters {
  return {
    ...filters,
    status,
    outcome:
      status !== 'all' && STATUS_IMPLYING_OUTCOMES.has(filters.outcome) ? 'all' : filters.outcome,
  };
}

export function selectSecurityFindingOutcome(
  filters: SecurityFindingFilters,
  outcome: SecurityOutcomeFilter
): SecurityFindingFilters {
  return {
    ...filters,
    status: STATUS_IMPLYING_OUTCOMES.has(outcome) ? 'all' : filters.status,
    outcome,
  };
}

export function toSecurityFindingQuery(
  filters: SecurityFindingFilters,
  offset = 0
): SecurityFindingQuery {
  const query: SecurityFindingQuery = {
    sortBy: filters.sortBy,
    limit: SECURITY_FINDINGS_PAGE_SIZE,
    offset,
  };
  if (filters.status !== 'all' && !STATUS_IMPLYING_OUTCOMES.has(filters.outcome)) {
    query.status = filters.status;
  }
  if (filters.severity !== 'all') {
    query.severity = filters.severity;
  }
  if (filters.outcome !== 'all') {
    query.outcomeFilter = filters.outcome;
  }
  if (filters.repoFullName !== null) {
    query.repoFullName = filters.repoFullName;
  }
  if (filters.overdue !== undefined) {
    query.overdue = filters.overdue;
  }
  return query;
}

export type SecurityFindingRouteParams = Partial<
  Record<'status' | 'severity' | 'outcomeFilter' | 'repoFullName' | 'sortBy' | 'overdue', string>
>;

function pickOr<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

// Parses route/query params — including the Dashboard's deep-link params
// (repoFullName, outcomeFilter, overdue) — into filter state. Unrecognized
// or malformed values fall back to the safe default rather than erroring,
// since these come from a URL a user could hand-edit or share.
export function parseSecurityFindingFilters(
  params: SecurityFindingRouteParams
): SecurityFindingFilters {
  const outcome = pickOr(
    params.outcomeFilter,
    OUTCOME_FILTERS,
    DEFAULT_SECURITY_FINDING_FILTERS.outcome
  );
  return {
    status: STATUS_IMPLYING_OUTCOMES.has(outcome)
      ? 'all'
      : pickOr(params.status, STATUS_FILTERS, DEFAULT_SECURITY_FINDING_FILTERS.status),
    severity: pickOr(params.severity, SEVERITY_FILTERS, DEFAULT_SECURITY_FINDING_FILTERS.severity),
    outcome,
    repoFullName: params.repoFullName ?? null,
    sortBy: pickOr(params.sortBy, SORT_OPTIONS, DEFAULT_SECURITY_FINDING_FILTERS.sortBy),
    overdue: params.overdue === 'true' ? true : undefined,
  };
}

// Default-open alone (the screen's initial state) is not an "active" user
// filter — only a change away from the default counts, so the UI can show
// a filter-reset affordance solely when it would actually change results.
export function hasActiveSecurityFindingFilters(filters: SecurityFindingFilters): boolean {
  return (
    filters.status !== DEFAULT_SECURITY_FINDING_FILTERS.status ||
    filters.severity !== DEFAULT_SECURITY_FINDING_FILTERS.severity ||
    filters.outcome !== DEFAULT_SECURITY_FINDING_FILTERS.outcome ||
    filters.repoFullName !== DEFAULT_SECURITY_FINDING_FILTERS.repoFullName ||
    filters.sortBy !== DEFAULT_SECURITY_FINDING_FILTERS.sortBy ||
    Boolean(filters.overdue)
  );
}
