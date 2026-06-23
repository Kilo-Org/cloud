'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React, { type FormEvent, type ReactNode, useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarDays, format as formatCalendarDateLabel } from 'date-fns';
import {
  Activity,
  Brain,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  FileClock,
  GitMerge,
  GitPullRequest,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { DateRange as DayPickerDateRange } from 'react-day-picker';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import { useSecurityAgent } from './SecurityAgentContext';
import { SecurityAgentActionBar, SecurityAgentActionBarField } from './SecurityAgentActionBar';
import { SeverityBadge } from './SeverityBadge';
import type {
  SecurityAgentAuditReport,
  SecurityAgentAuditReportEvent,
  SecurityFindingAuditSection,
} from '@/lib/security-agent/db/security-audit-report';

type DateRange = {
  startDate: string;
  endDate: string;
};

type AuditReportSeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';
type AuditReportStateFilter = 'all' | 'open' | 'fixed' | 'ignored' | 'superseded' | 'deleted';

export type AuditReportFilters = {
  severity: AuditReportSeverityFilter;
  state: AuditReportStateFilter;
  repository: string | null;
};

export type AuditReportControlsState = {
  draftRange: DayPickerDateRange | undefined;
  submittedRange: DateRange;
  draftFilters: AuditReportFilters;
  submittedFilters: AuditReportFilters;
  isRangePickerOpen: boolean;
};

type AuditReportControlsStateInput = {
  initialRange: DateRange;
  initialFilters: AuditReportFilters;
};

type AuditReportControlsAction =
  | {
      type: 'set-range-picker-open';
      open: boolean;
    }
  | {
      type: 'select-draft-range';
      range: DayPickerDateRange | undefined;
      closePicker: boolean;
    }
  | {
      type: 'set-draft-filter';
      filter: Partial<AuditReportFilters>;
    }
  | {
      type: 'submit-report' | 'sync-from-url';
      range: DateRange;
      filters: AuditReportFilters;
    }
  | {
      type: 'clear-filters';
    };

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const FINDING_SUPERSEDED_ACTION = 'security.finding.superseded';
const MAX_AUDIT_REPORT_DAYS = 90;
const MAX_AUDIT_REPORT_RANGE_NIGHTS = MAX_AUDIT_REPORT_DAYS - 1;
const ALL_AUDIT_REPORT_FILTERS: AuditReportFilters = {
  severity: 'all',
  state: 'all',
  repository: null,
};

type Tone = 'success' | 'warning' | 'destructive' | 'neutral';
type FindingDisplayState = 'open' | 'fixed' | 'dismissed' | 'superseded' | 'deleted' | 'unknown';

type EventPresentation = {
  icon: LucideIcon;
  tone: Tone;
};

const toneStyles = {
  success: {
    status: 'border-status-success-border bg-status-success-surface text-status-success',
    icon: 'bg-status-success-surface text-status-success-icon ring-status-success-border',
    text: 'text-status-success',
  },
  warning: {
    status: 'border-status-warning-border bg-status-warning-surface text-status-warning',
    icon: 'bg-status-warning-surface text-status-warning-icon ring-status-warning-border',
    text: 'text-status-warning',
  },
  destructive: {
    status:
      'border-status-destructive-border bg-status-destructive-surface text-status-destructive',
    icon: 'bg-status-destructive-surface text-status-destructive-icon ring-status-destructive-border',
    text: 'text-status-destructive',
  },
  neutral: {
    status: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
    icon: 'bg-status-neutral-surface text-status-neutral-icon ring-status-neutral-border',
    text: 'text-status-neutral',
  },
} satisfies Record<Tone, { status: string; icon: string; text: string }>;

const findingStateConfig = {
  open: { label: 'Open', tone: 'neutral', icon: CircleDot },
  fixed: { label: 'Fixed', tone: 'success', icon: CheckCircle2 },
  dismissed: { label: 'Dismissed', tone: 'neutral', icon: XCircle },
  superseded: { label: 'Superseded', tone: 'neutral', icon: GitMerge },
  deleted: { label: 'Deleted', tone: 'neutral', icon: Trash2 },
  unknown: { label: 'Unknown', tone: 'neutral', icon: CircleDot },
} satisfies Record<FindingDisplayState, { label: string; tone: Tone; icon: LucideIcon }>;

const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const REPORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});
const REPORT_DATE_TIME_24_HOUR_FORMATTER = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
  timeZoneName: 'short',
});
const AUDIT_EVENT_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

export function hasSecurityAgentAuditReportOwnerContext(
  isOrg: boolean,
  organizationId: string | undefined
): boolean {
  return !isOrg || Boolean(organizationId);
}

export function createAuditReportControlsState({
  initialRange,
  initialFilters,
}: AuditReportControlsStateInput): AuditReportControlsState {
  return {
    draftRange: toDayPickerDateRange(initialRange),
    submittedRange: initialRange,
    draftFilters: initialFilters,
    submittedFilters: initialFilters,
    isRangePickerOpen: false,
  };
}

export function auditReportControlsReducer(
  state: AuditReportControlsState,
  action: AuditReportControlsAction
): AuditReportControlsState {
  switch (action.type) {
    case 'set-range-picker-open':
      return { ...state, isRangePickerOpen: action.open };
    case 'select-draft-range':
      return {
        ...state,
        draftRange: action.range,
        isRangePickerOpen: action.closePicker ? false : state.isRangePickerOpen,
      };
    case 'set-draft-filter':
      return {
        ...state,
        draftFilters: { ...state.draftFilters, ...action.filter },
      };
    case 'sync-from-url':
      return {
        draftRange: toDayPickerDateRange(action.range),
        submittedRange: action.range,
        draftFilters: action.filters,
        submittedFilters: action.filters,
        isRangePickerOpen: false,
      };
    case 'submit-report':
      return {
        ...state,
        submittedRange: action.range,
        draftFilters: action.filters,
        submittedFilters: action.filters,
      };
    case 'clear-filters':
      return {
        ...state,
        draftFilters: ALL_AUDIT_REPORT_FILTERS,
        submittedFilters: ALL_AUDIT_REPORT_FILTERS,
      };
  }
}

export function SecurityAuditReportPage() {
  const trpc = useTRPC();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isOrg, organizationId } = useSecurityAgent();
  const requestedRange = {
    startDate: searchParams.get('startDate') ?? '',
    endDate: searchParams.get('endDate') ?? '',
  };
  const initialRange = isValidAuditReportDateRange(requestedRange)
    ? requestedRange
    : getDefaultAuditReportDateRange();
  const initialFilters = parseAuditReportFilters(searchParams);
  const { startDate: initialStartDate, endDate: initialEndDate } = initialRange;
  const {
    severity: initialSeverity,
    state: initialState,
    repository: initialRepository,
  } = initialFilters;
  const [controlsState, dispatchControlsState] = useReducer(
    auditReportControlsReducer,
    { initialRange, initialFilters },
    createAuditReportControlsState
  );
  const { draftRange, submittedRange, draftFilters, submittedFilters, isRangePickerOpen } =
    controlsState;

  useEffect(() => {
    dispatchControlsState({
      type: 'sync-from-url',
      range: { startDate: initialStartDate, endDate: initialEndDate },
      filters: {
        severity: initialSeverity,
        state: initialState,
        repository: initialRepository,
      },
    });
  }, [initialStartDate, initialEndDate, initialSeverity, initialState, initialRepository]);

  const completeDraftRange = toAuditReportDateRange(draftRange);
  const latestSelectableDate = utcDateAsLocalCalendarDate(new Date());
  const hasOwnerContext = hasSecurityAgentAuditReportOwnerContext(isOrg, organizationId);

  const queryOptions = isOrg
    ? trpc.organizations.securityAgent.getAuditReport.queryOptions({
        organizationId: organizationId ?? '',
        ...submittedRange,
      })
    : trpc.securityAgent.getAuditReport.queryOptions(submittedRange);

  const {
    data: reportQueryData,
    isFetching: isReportFetching,
    isLoading: isReportLoading,
    isError: isReportError,
    refetch: refetchReport,
  } = useQuery({
    ...queryOptions,
    enabled: hasOwnerContext,
  });

  const unfilteredReport = reportQueryData?.status === 'ok' ? reportQueryData.report : null;
  const repositoryOptions = getAuditReportRepositoryOptions(unfilteredReport?.findings ?? []);
  const effectiveDraftFilters = unfilteredReport
    ? normalizeAuditReportRepositoryFilter(draftFilters, repositoryOptions)
    : draftFilters;
  const effectiveSubmittedFilters = unfilteredReport
    ? normalizeAuditReportRepositoryFilter(submittedFilters, repositoryOptions)
    : submittedFilters;
  const report = unfilteredReport
    ? filterSecurityAgentAuditReport(unfilteredReport, effectiveSubmittedFilters)
    : null;

  function replaceReportUrl(range: DateRange, filters: AuditReportFilters) {
    const queryString = buildAuditReportSearchParams(searchParams.toString(), range, filters);
    router.replace(`${pathname}?${queryString}`, { scroll: false });
  }

  function handleGenerateReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!completeDraftRange) return;
    const isSameRange =
      completeDraftRange.startDate === submittedRange.startDate &&
      completeDraftRange.endDate === submittedRange.endDate;

    dispatchControlsState({
      type: 'submit-report',
      range: completeDraftRange,
      filters: effectiveDraftFilters,
    });
    replaceReportUrl(completeDraftRange, effectiveDraftFilters);
    if (isSameRange) void refetchReport();
  }

  function handleDateRangeSelect(nextRange: DayPickerDateRange | undefined) {
    if (nextRange?.from && nextRange.to && !isWithinAuditReportRangeLimit(nextRange)) return;
    dispatchControlsState({
      type: 'select-draft-range',
      range: nextRange,
      closePicker: Boolean(nextRange?.from && nextRange.to),
    });
  }

  function handleClearFilters() {
    dispatchControlsState({ type: 'clear-filters' });
    replaceReportUrl(submittedRange, ALL_AUDIT_REPORT_FILTERS);
  }

  return (
    <div className="space-y-6">
      {!hasOwnerContext && (
        <div className="text-muted-foreground type-body flex items-center justify-center gap-2 py-16">
          <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading audit report...
        </div>
      )}

      {hasOwnerContext && (
        <>
          <SecurityAgentActionBar label="Audit report filters" asChild>
            <form onSubmit={handleGenerateReport}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(18rem,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(13rem,1.3fr)_auto] xl:items-end">
                <SecurityAgentActionBarField
                  id="audit-report-date-range"
                  label="Report period"
                  className="md:col-span-2 xl:col-span-1"
                >
                  <Popover
                    open={isRangePickerOpen}
                    onOpenChange={open =>
                      dispatchControlsState({ type: 'set-range-picker-open', open })
                    }
                  >
                    <PopoverTrigger asChild>
                      <Button
                        id="audit-report-date-range"
                        type="button"
                        variant="outline"
                        aria-invalid={Boolean(draftRange?.from && !completeDraftRange)}
                        className="type-body min-h-11 w-full justify-start text-left font-normal sm:min-h-9"
                      >
                        <CalendarDays aria-hidden="true" />
                        <span className="truncate">{formatDayPickerDateRange(draftRange)}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      sideOffset={6}
                      className="max-h-[calc(100vh-2rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
                    >
                      <Calendar
                        mode="range"
                        selected={draftRange}
                        onSelect={handleDateRangeSelect}
                        defaultMonth={draftRange?.from}
                        numberOfMonths={2}
                        max={MAX_AUDIT_REPORT_RANGE_NIGHTS}
                        disabled={{ after: latestSelectableDate }}
                        excludeDisabled
                        autoFocus
                      />
                      <p className="border-border text-muted-foreground type-label border-t px-3 py-2">
                        Report periods can include up to {MAX_AUDIT_REPORT_DAYS} calendar days.
                      </p>
                    </PopoverContent>
                  </Popover>
                </SecurityAgentActionBarField>

                <SecurityAgentActionBarField id="audit-report-severity" label="Severity">
                  <Select
                    value={draftFilters.severity}
                    onValueChange={severity =>
                      dispatchControlsState({
                        type: 'set-draft-filter',
                        filter: {
                          severity: parseAuditReportSeverityFilter(severity),
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id="audit-report-severity"
                      className="min-h-11 w-full sm:min-h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All severities</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </SecurityAgentActionBarField>

                <SecurityAgentActionBarField id="audit-report-state" label="Recorded state">
                  <Select
                    value={draftFilters.state}
                    onValueChange={state =>
                      dispatchControlsState({
                        type: 'set-draft-filter',
                        filter: {
                          state: parseAuditReportStateFilter(state),
                        },
                      })
                    }
                  >
                    <SelectTrigger id="audit-report-state" className="min-h-11 w-full sm:min-h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All states</SelectItem>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="fixed">Fixed</SelectItem>
                      <SelectItem value="ignored">Dismissed</SelectItem>
                      <SelectItem value="superseded">Superseded</SelectItem>
                      <SelectItem value="deleted">Deleted</SelectItem>
                    </SelectContent>
                  </Select>
                </SecurityAgentActionBarField>

                <SecurityAgentActionBarField id="audit-report-repository" label="Repository">
                  <Select
                    value={effectiveDraftFilters.repository ?? 'all'}
                    onValueChange={repository =>
                      dispatchControlsState({
                        type: 'set-draft-filter',
                        filter: {
                          repository: parseAuditReportRepositoryFilter(repository),
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id="audit-report-repository"
                      className="min-h-11 w-full sm:min-h-9"
                    >
                      <SelectValue placeholder="All repositories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All repositories</SelectItem>
                      {repositoryOptions.map(repository => (
                        <SelectItem key={repository} value={repository}>
                          {repository}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SecurityAgentActionBarField>

                <Button
                  type="submit"
                  disabled={isReportFetching || !completeDraftRange}
                  className="min-h-11 w-full self-end sm:min-h-9 xl:w-fit"
                >
                  <RefreshCw
                    className={cn(isReportFetching && 'animate-spin motion-reduce:animate-none')}
                    aria-hidden="true"
                  />
                  {isReportFetching ? 'Generating report...' : 'Generate report'}
                </Button>
              </div>
            </form>
          </SecurityAgentActionBar>
        </>
      )}

      {hasOwnerContext && isReportLoading && <AuditReportSkeleton />}

      {hasOwnerContext && isReportError && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Audit report could not be loaded</AlertTitle>
          <AlertDescription>
            Kilo did not return partial report content. Check your connection and generate the
            report again.
          </AlertDescription>
        </Alert>
      )}

      {hasOwnerContext && reportQueryData?.status === 'query_failed' && (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Report query did not finish</AlertTitle>
          <AlertDescription>
            Kilo did not return partial report content. Choose a shorter UTC period and generate the
            report again.
          </AlertDescription>
        </Alert>
      )}

      {hasOwnerContext && report && unfilteredReport && (
        <AuditReportView
          report={report}
          provenanceReport={unfilteredReport}
          totalFindingCount={unfilteredReport.summary.findingCount}
          hasActiveFilters={hasActiveAuditReportFilters(effectiveSubmittedFilters)}
          onClearFilters={handleClearFilters}
        />
      )}
    </div>
  );
}

function AuditReportView({
  report,
  provenanceReport,
  totalFindingCount,
  hasActiveFilters,
  onClearFilters,
}: {
  report: SecurityAgentAuditReport;
  provenanceReport: SecurityAgentAuditReport;
  totalFindingCount: number;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  return (
    <div className="space-y-6">
      <AuditReportProvenance report={provenanceReport} />
      <ReportSummary report={report} />

      {report.findings.length === 0 ? (
        <AuditReportEmptyState
          startDate={formatDate(report.period.start)}
          endDate={formatDate(report.period.displayEnd)}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={onClearFilters}
        />
      ) : (
        <FindingTimelineList findings={report.findings} totalFindingCount={totalFindingCount} />
      )}
    </div>
  );
}

export function getAuditReportProvenance(report: SecurityAgentAuditReport) {
  const startsBeforeReliableCoverage =
    Date.parse(report.period.start) < Date.parse(report.reliableCoverageStart);
  let warning: string | null = null;

  if (startsBeforeReliableCoverage && report.hasLegacySupplementalActivity) {
    warning =
      'This period starts before reliable event coverage, and supplemental legacy activity may be incomplete.';
  } else if (startsBeforeReliableCoverage) {
    warning = 'Activity before reliable event coverage may be incomplete.';
  } else if (report.hasLegacySupplementalActivity) {
    warning = 'Supplemental legacy activity may be incomplete.';
  }

  return {
    evidence: {
      recorded_by_kilo: 'Security Finding activity recorded by Kilo.',
    }[report.evidenceBasis],
    dataThrough: formatReportDateTime(report.dataThrough),
    reliableCoverageStart: formatReportDateTime(report.reliableCoverageStart),
    warning,
  };
}

export function AuditReportProvenance({ report }: { report: SecurityAgentAuditReport }) {
  const provenance = getAuditReportProvenance(report);

  return (
    <section
      className="border-border bg-surface-inset rounded-lg border px-4 py-3"
      aria-labelledby="report-provenance-title"
    >
      <div className="flex items-start gap-3">
        <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="report-provenance-title" className="type-label text-foreground">
            Report provenance
          </h2>
          <p className="text-muted-foreground type-body mt-0.5">{provenance.evidence}</p>
          <dl className="text-muted-foreground type-label mt-2 flex flex-wrap gap-x-5 gap-y-1">
            <div className="flex flex-wrap gap-x-1.5">
              <dt>Data cutoff</dt>
              <dd className="text-foreground tabular-nums">
                <time dateTime={report.dataThrough}>{provenance.dataThrough}</time>
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-1.5">
              <dt>Reliable coverage starts</dt>
              <dd className="text-foreground tabular-nums">
                <time dateTime={report.reliableCoverageStart}>
                  {provenance.reliableCoverageStart}
                </time>
              </dd>
            </div>
          </dl>
          {provenance.warning && (
            <p className="text-status-warning type-label mt-2 flex items-start gap-1.5">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span>{provenance.warning}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ReportSummary({ report }: { report: SecurityAgentAuditReport }) {
  const metrics = [
    { label: 'Findings', value: report.summary.findingCount },
    { label: 'Events', value: report.summary.activityCount },
    {
      label: 'Superseded',
      value: report.summary.byAction[FINDING_SUPERSEDED_ACTION] ?? 0,
    },
    ...SEVERITY_ORDER.map(severity => ({
      label: titleCase(severity),
      value: report.summary.bySeverity[severity],
    })),
  ];

  return (
    <section
      className="border-border bg-surface-raised overflow-hidden rounded-xl border"
      aria-labelledby="report-summary-title"
    >
      <div className="border-border border-b px-4 py-3 sm:px-5">
        <h2 id="report-summary-title" className="type-body font-medium">
          Report summary
        </h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7">
        {metrics.map(metric => (
          <div
            key={metric.label}
            className="border-border min-w-0 border-r border-b px-4 py-4 last:border-r-0 sm:[&:nth-child(4n)]:border-r-0 lg:border-b-0 lg:[&:nth-child(4n)]:border-r lg:[&:nth-child(7n)]:border-r-0"
          >
            <div className="text-2xl font-semibold tabular-nums">
              {metric.value.toLocaleString()}
            </div>
            <div className="text-muted-foreground type-label mt-1">{metric.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AuditReportEmptyState({
  startDate,
  endDate,
  hasActiveFilters,
  onClearFilters,
}: {
  startDate: string;
  endDate: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  return (
    <section className="border-border bg-surface-raised flex items-start gap-4 rounded-xl border p-5 sm:p-6">
      <div className="bg-surface-overlay text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
        <FileClock className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <h2 className="type-heading">
          {hasActiveFilters ? 'No findings match selected filters' : 'No recorded activity'}
        </h2>
        <p className="text-muted-foreground type-body mt-1 max-w-[65ch]">
          {hasActiveFilters
            ? 'No Security Finding groups in this report match the selected severity, state, and repository.'
            : `Kilo has no reportable Security Finding activity from ${startDate} to ${endDate}.`}
        </p>
        {hasActiveFilters && (
          <Button type="button" variant="outline" className="mt-4" onClick={onClearFilters}>
            Clear filters
          </Button>
        )}
      </div>
    </section>
  );
}

function FindingTimelineList({
  findings,
  totalFindingCount,
}: {
  findings: SecurityFindingAuditSection[];
  totalFindingCount: number;
}) {
  return (
    <section className="space-y-3" aria-label="Finding activity">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <p className="text-muted-foreground type-body">
          Expand a Security Finding to review its complete in-period timeline.
        </p>
        <p className="text-muted-foreground type-code tabular-nums">
          Showing {findings.length.toLocaleString()} of {totalFindingCount.toLocaleString()}
        </p>
      </div>

      <div className="border-border bg-surface-raised overflow-hidden rounded-xl border">
        <div
          className="border-border bg-surface-inset text-muted-foreground type-label hidden grid-cols-[minmax(0,1fr)_9rem_11rem] gap-4 border-b py-2.5 pr-4 pl-11 lg:grid"
          aria-hidden="true"
        >
          <span>Security Finding</span>
          <span>Recorded state</span>
          <span>Latest activity</span>
        </div>
        <Accordion type="multiple">
          {findings.map(finding => (
            <AccordionItem
              key={finding.findingId}
              value={finding.findingId}
              className="[&>[data-slot=accordion-content]]:mt-0"
            >
              <AccordionTrigger className="hover:bg-surface-hover data-[state=open]:bg-surface-selected min-h-control-touch items-center rounded-none px-4 py-3 hover:no-underline [&>svg]:translate-y-0">
                <FindingSummary finding={finding} />
              </AccordionTrigger>
              <AccordionContent className="border-border bg-surface-inset border-t px-4 py-5 sm:px-5 sm:py-6">
                <FindingDetails finding={finding} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

function FindingSummary({ finding }: { finding: SecurityFindingAuditSection }) {
  const latestEvent = finding.events[finding.events.length - 1];
  const eventCountLabel = `${finding.events.length.toLocaleString()} ${finding.events.length === 1 ? 'event' : 'events'}`;

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 lg:grid-cols-[minmax(0,1fr)_9rem_11rem] lg:items-center lg:gap-4">
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex w-20 shrink-0 items-center">
            {finding.severity === 'unknown' ? (
              <Badge variant="outline">Unknown</Badge>
            ) : (
              <SeverityBadge severity={finding.severity} size="sm" />
            )}
          </div>
          <div className="min-w-0">
            <div className="type-body break-words font-medium">{finding.title}</div>
          </div>
        </div>
      </div>

      <div className="col-start-1 row-start-2 lg:col-start-2 lg:row-start-1">
        <FindingStateBadge finding={finding} />
      </div>

      <div className="col-start-2 row-start-2 min-w-0 text-right lg:col-start-3 lg:row-start-1 lg:text-left">
        {latestEvent && (
          <div className="type-label truncate text-foreground">{latestEvent.label}</div>
        )}
        <div className="text-muted-foreground type-label mt-0.5 tabular-nums">
          {latestEvent ? (
            <time dateTime={latestEvent.occurredAt}>{formatDate(latestEvent.occurredAt)}</time>
          ) : (
            'No activity'
          )}
          <span aria-hidden="true"> · </span>
          <span>{eventCountLabel}</span>
        </div>
      </div>
    </div>
  );
}

function FindingStateBadge({ finding }: { finding: SecurityFindingAuditSection }) {
  const state = getFindingDisplayState(finding);
  const config = findingStateConfig[state];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'type-label inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        toneStyles[config.tone].status
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {config.label}
    </span>
  );
}

function FindingDetails({ finding }: { finding: SecurityFindingAuditSection }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8">
      <div className="min-w-0">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="type-body font-medium">Chronological activity</h3>
          <span className="text-muted-foreground type-label">UTC</span>
        </div>
        <ol>
          {finding.events.map((event, index) => (
            <AuditEventRow
              key={event.id}
              event={event}
              isLast={index === finding.events.length - 1}
            />
          ))}
        </ol>
      </div>
      <FindingMetadata finding={finding} />
    </div>
  );
}

function FindingMetadata({ finding }: { finding: SecurityFindingAuditSection }) {
  const advisoryReferences = [finding.cveId, finding.ghsaId].filter((value): value is string =>
    Boolean(value)
  );
  const repositoryHref = getAuditReportRepositoryHref(finding.repository);
  const sourceHref =
    finding.dependabotUrl && isSafeHttpUrl(finding.dependabotUrl) ? finding.dependabotUrl : null;
  const slaTone = getSlaTone(finding.sla.status);

  return (
    <aside
      className="border-border min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
      aria-label="Finding record"
    >
      <h3 className="type-body font-medium">Finding record</h3>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <MetadataItem label="Security Finding ID" value={finding.findingId} mono />
        {finding.canonicalFindingId && (
          <MetadataItem label="Current finding" value={finding.canonicalFindingId} mono />
        )}
        <MetadataItem label="Source">
          {sourceHref ? (
            <ExternalLinkValue href={sourceHref}>{formatFindingSource(finding)}</ExternalLinkValue>
          ) : (
            formatFindingSource(finding)
          )}
        </MetadataItem>
        <MetadataItem label="Repository">
          {repositoryHref ? (
            <ExternalLinkValue href={repositoryHref}>
              {finding.repository ?? 'Not recorded'}
            </ExternalLinkValue>
          ) : (
            (finding.repository ?? 'Not recorded')
          )}
        </MetadataItem>
        <MetadataItem label="Package" value={formatFindingPackage(finding)} />
        <MetadataItem label="Manifest" value={finding.manifestPath ?? 'Not recorded'} mono />
        <MetadataItem
          label="First detected"
          value={
            finding.firstDetectedAt ? formatReportDateTime(finding.firstDetectedAt) : 'Unknown'
          }
          mono
        />
        <MetadataItem label="SLA status">
          <span className={cn('type-label font-medium', toneStyles[slaTone].text)}>
            {slaLabel(finding.sla)}
          </span>
        </MetadataItem>
        <MetadataItem
          label="SLA deadline"
          value={finding.sla.deadline ? formatReportDateTime(finding.sla.deadline) : 'Not recorded'}
          mono
        />
        <AdvisoryMetadata references={advisoryReferences} cvssScore={finding.cvssScore} />
        <MetadataItem
          label="Patched version"
          value={finding.patchedVersion ?? 'Not recorded'}
          mono
        />
      </dl>
    </aside>
  );
}

function AuditEventRow({
  event,
  isLast,
}: {
  event: SecurityAgentAuditReportEvent;
  isLast: boolean;
}) {
  const presentation = getEventPresentation(event);
  const Icon = presentation.icon;
  const actorReference = event.actor.type === 'user' ? `user:${event.actor.id ?? 'deleted'}` : null;

  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-7 last:pb-0 sm:grid-cols-[7.5rem_1.75rem_minmax(0,1fr)]">
      <time
        dateTime={event.occurredAt}
        className="text-muted-foreground type-label col-start-2 row-start-1 mb-2 flex flex-wrap gap-x-1.5 tabular-nums sm:col-start-1 sm:mb-0 sm:block sm:pr-1 sm:text-right"
      >
        <span className="sm:block">{formatDate(event.occurredAt)}</span>
        <span className="sm:mt-0.5 sm:block">{formatAuditEventTime(event.occurredAt)}</span>
      </time>

      <div
        className="relative col-start-1 row-span-2 row-start-1 flex justify-center sm:col-start-2"
        aria-hidden="true"
      >
        {!isLast && <span className="bg-border absolute top-7 -bottom-7 w-px" />}
        <span
          className={cn(
            'relative flex size-7 items-center justify-center rounded-full ring-1',
            toneStyles[presentation.tone].icon
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>

      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-span-2 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="type-body font-medium">{event.label}</h4>
          {event.legacySupplemental && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Legacy event information"
                  className="border-border bg-surface-overlay text-muted-foreground focus-visible:ring-ring type-label inline-flex items-center gap-1 rounded-full border px-2 py-0.5 outline-none focus-visible:ring-[3px]"
                >
                  <Info className="size-3" aria-hidden="true" />
                  Legacy
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                This event comes from an older record mapped to this finding. Earlier activity may
                be incomplete.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="text-muted-foreground type-label mt-1 flex flex-wrap gap-x-2 gap-y-1">
          <span>{event.actor.displayName}</span>
          {actorReference && <code className="type-code">{actorReference}</code>}
        </div>
        <EventDetails event={event} />
      </div>
    </li>
  );
}

function getFindingDisplayState(finding: SecurityFindingAuditSection): FindingDisplayState {
  if (finding.deleted) return 'deleted';
  if (finding.canonicalFindingId) return 'superseded';
  if (finding.status === 'open') return 'open';
  if (finding.status === 'fixed') return 'fixed';
  if (finding.status === 'ignored' || finding.status === 'dismissed') return 'dismissed';
  return 'unknown';
}

function getSlaTone(status: SecurityFindingAuditSection['sla']['status']): Tone {
  if (status === 'terminal_met') return 'success';
  if (status === 'terminal_missed' || status === 'open_past_deadline') return 'destructive';
  if (status === 'open_within_deadline') return 'warning';
  return 'neutral';
}

function getEventPresentation(event: SecurityAgentAuditReportEvent): EventPresentation {
  switch (event.action) {
    case 'security.finding.severity_changed':
      return { icon: TriangleAlert, tone: 'warning' };
    case 'security.finding.status_change':
      return event.afterState?.status === 'fixed'
        ? { icon: CheckCircle2, tone: 'success' }
        : { icon: XCircle, tone: 'neutral' };
    case 'security.finding.dismissed':
    case 'security.finding.auto_dismissed':
      return { icon: XCircle, tone: 'neutral' };
    case 'security.finding.superseded':
      return { icon: GitMerge, tone: 'neutral' };
    case 'security.finding.analysis_completed':
      if (event.afterState?.is_exploitable === true) return { icon: Brain, tone: 'destructive' };
      if (event.afterState?.is_exploitable === false) return { icon: Brain, tone: 'success' };
      return { icon: Brain, tone: 'warning' };
    case 'security.finding.analysis_failed':
    case 'security.remediation.failed':
      return { icon: XCircle, tone: 'destructive' };
    case 'security.remediation.queued':
      return { icon: event.actor.type === 'user' ? UserRound : Activity, tone: 'neutral' };
    case 'security.remediation.pr_opened':
      return { icon: GitPullRequest, tone: 'success' };
    case 'security.remediation.blocked':
      return { icon: TriangleAlert, tone: 'warning' };
    case 'security.remediation.no_changes_needed':
      return { icon: ShieldCheck, tone: 'success' };
    case 'security.remediation.cancelled':
      return { icon: XCircle, tone: 'neutral' };
    case 'security.finding.deleted':
      return { icon: Trash2, tone: 'neutral' };
    default:
      return { icon: Activity, tone: 'neutral' };
  }
}

export type AuditEventDetail = {
  label: string;
  value: string;
  previousValue?: string;
  href?: string;
};

function eventDetail(
  label: string,
  value: unknown,
  fieldKey: string,
  previousValue?: unknown
): AuditEventDetail | null {
  if (value === null || value === undefined || value === '') return null;
  const detail: AuditEventDetail = {
    label,
    value: formatEvidenceScalar(value, fieldKey),
  };
  if (previousValue !== null && previousValue !== undefined && previousValue !== '') {
    const previousLabel = formatEvidenceScalar(previousValue, fieldKey);
    if (previousLabel !== detail.value) detail.previousValue = previousLabel;
  }
  return detail;
}

function presentEventDetails(
  details: Array<AuditEventDetail | null | undefined>
): AuditEventDetail[] {
  return details.filter((detail): detail is AuditEventDetail => Boolean(detail));
}

export function getAuditEventDetails(event: SecurityAgentAuditReportEvent): AuditEventDetail[] {
  const before = event.beforeState ?? {};
  const after = event.afterState ?? {};
  const metadata = event.metadata ?? {};

  switch (event.action) {
    case 'security.finding.created':
      return presentEventDetails([
        eventDetail('Severity', after.severity, 'severity'),
        eventDetail('State', after.status, 'status'),
        eventDetail('Dependabot alert', metadata.source_alert_number, 'source_alert_number'),
      ]);
    case 'security.finding.severity_changed':
      return presentEventDetails([
        eventDetail('Severity', after.severity, 'severity', before.severity),
      ]);
    case 'security.finding.status_change':
      return presentEventDetails([
        eventDetail('State', after.status, 'status', before.status),
        eventDetail('Fixed', after.fixed_at, 'fixed_at'),
      ]);
    case 'security.finding.dismissed':
    case 'security.finding.auto_dismissed':
    case 'security.finding.superseded':
      return presentEventDetails([
        eventDetail('State', after.status, 'status', before.status),
        eventDetail('Reason', after.reason_code ?? metadata.reason_code, 'reason_code'),
      ]);
    case 'security.finding.analysis_completed': {
      const structuredExtractionStatus = after.structured_extraction_status;
      const structuredExtractionFailed = structuredExtractionStatus === 'failed';
      return presentEventDetails([
        structuredExtractionFailed
          ? eventDetail(
              'Structured result',
              structuredExtractionStatus,
              'structured_extraction_status'
            )
          : eventDetail('Exploitability', after.is_exploitable, 'is_exploitable'),
        eventDetail('Recommended next step', after.suggested_action, 'suggested_action'),
        eventDetail(
          'Confidence',
          structuredExtractionStatus === undefined ? after.confidence : undefined,
          'confidence'
        ),
      ]);
    }
    case 'security.finding.analysis_failed':
      return presentEventDetails([eventDetail('Reason', metadata.failure_code, 'failure_code')]);
    case 'security.remediation.queued':
      return presentEventDetails([
        eventDetail('Attempt', after.attempt_number, 'attempt_number'),
        eventDetail('Requested', metadata.origin, 'origin'),
      ]);
    case 'security.remediation.pr_opened': {
      const pullRequest = eventDetail('Pull request', after.pr_number, 'pr_number');
      if (pullRequest && typeof metadata.pr_url === 'string' && isSafeHttpUrl(metadata.pr_url)) {
        pullRequest.href = metadata.pr_url;
      }
      return presentEventDetails([
        pullRequest,
        eventDetail('Review state', after.pr_draft, 'pr_draft'),
        eventDetail('Validation checks', metadata.validation_count, 'validation_count'),
      ]);
    }
    case 'security.remediation.failed':
      return presentEventDetails([
        eventDetail('Reason', after.failure_code ?? metadata.failure_code, 'failure_code'),
      ]);
    case 'security.remediation.blocked':
      return presentEventDetails([
        eventDetail(
          'Reason',
          after.blocked_reason_code ?? metadata.blocked_reason_code,
          'blocked_reason_code'
        ),
      ]);
    case 'security.finding.deleted':
      return presentEventDetails([eventDetail('Previous state', before.status, 'status')]);
    default:
      return [];
  }
}

function EventDetails({ event }: { event: SecurityAgentAuditReportEvent }) {
  const details = getAuditEventDetails(event);
  if (details.length === 0) return null;

  return (
    <dl className="border-border mt-3 grid gap-x-6 gap-y-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-3">
      {details.map(detail => (
        <div key={detail.label} className="min-w-0">
          <dt className="text-muted-foreground type-label">{detail.label}</dt>
          <dd
            className={cn(
              'type-body mt-1 break-words',
              isMonospaceEventDetail(detail.label) && 'type-code'
            )}
          >
            {detail.href ? (
              <ExternalLinkValue href={detail.href}>{detail.value}</ExternalLinkValue>
            ) : detail.previousValue ? (
              <span>
                <span className="text-muted-foreground">{detail.previousValue}</span>
                <span className="text-muted-foreground" aria-hidden="true">
                  {' '}
                  →{' '}
                </span>
                <span className="sr-only"> changed to </span>
                {detail.value}
              </span>
            ) : (
              detail.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function isMonospaceEventDetail(label: string): boolean {
  return label === 'Dependabot alert' || label === 'Pull request';
}

function MetadataItem({
  label,
  value,
  mono = false,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground type-label">{label}</dt>
      <dd className={cn('type-body mt-1 break-words', mono && 'type-code')}>{children ?? value}</dd>
    </div>
  );
}

function ExternalLinkValue({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link hover:text-link-hover focus-visible:ring-ring inline-flex max-w-full items-center gap-1 rounded-sm underline decoration-current/40 underline-offset-4 outline-none focus-visible:ring-[3px]"
    >
      <span className="min-w-0 break-words">{children}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function AdvisoryMetadata({
  references,
  cvssScore,
}: {
  references: string[];
  cvssScore: SecurityFindingAuditSection['cvssScore'];
}) {
  const hasAdvisoryMetadata = references.length > 0 || cvssScore !== null;

  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground type-label">Advisory</dt>
      <dd className="mt-1">
        {hasAdvisoryMetadata ? (
          <div className="flex flex-wrap gap-1.5">
            {references.map(reference => (
              <Badge key={reference} variant="outline" className="type-code font-normal">
                {reference}
              </Badge>
            ))}
            {cvssScore !== null && (
              <Badge variant="secondary" className="font-normal">
                CVSS {cvssScore}
              </Badge>
            )}
          </div>
        ) : (
          <span className="type-body">Not recorded</span>
        )}
      </dd>
    </div>
  );
}

function AuditReportSkeleton() {
  return (
    <output className="block space-y-6" aria-live="polite">
      <span className="sr-only">Loading recorded activity</span>
      <Skeleton className="motion-reduce:animate-none h-16" />
      <Skeleton className="motion-reduce:animate-none h-32" />
      <div className="space-y-2">
        <Skeleton className="motion-reduce:animate-none h-16" />
        <Skeleton className="motion-reduce:animate-none h-16" />
        <Skeleton className="motion-reduce:animate-none h-16" />
      </div>
    </output>
  );
}

type SearchParamsReader = {
  get(name: string): string | null;
};

export function buildAuditReportSearchParams(
  currentSearchParams: string,
  range: DateRange,
  filters: AuditReportFilters
): string {
  const searchParams = new URLSearchParams(currentSearchParams);
  searchParams.set('startDate', range.startDate);
  searchParams.set('endDate', range.endDate);

  setOptionalAuditReportSearchParam(searchParams, 'severity', filters.severity, 'all');
  setOptionalAuditReportSearchParam(searchParams, 'state', filters.state, 'all');
  setOptionalAuditReportSearchParam(searchParams, 'repoFullName', filters.repository, null);

  return searchParams.toString();
}

function setOptionalAuditReportSearchParam(
  searchParams: URLSearchParams,
  name: string,
  value: string | null,
  defaultValue: string | null
) {
  if (value === defaultValue) {
    searchParams.delete(name);
    return;
  }
  if (value !== null) searchParams.set(name, value);
}

export function parseAuditReportFilters(searchParams: SearchParamsReader): AuditReportFilters {
  return {
    severity: parseAuditReportSeverityFilter(searchParams.get('severity')),
    state: parseAuditReportStateFilter(searchParams.get('state')),
    repository: parseAuditReportRepositoryFilter(searchParams.get('repoFullName')),
  };
}

function parseAuditReportSeverityFilter(value: string | null): AuditReportSeverityFilter {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'all';
}

function parseAuditReportStateFilter(value: string | null): AuditReportStateFilter {
  if (
    value === 'open' ||
    value === 'fixed' ||
    value === 'ignored' ||
    value === 'superseded' ||
    value === 'deleted'
  ) {
    return value;
  }
  return 'all';
}

function parseAuditReportRepositoryFilter(value: string | null): string | null {
  const repository = value?.trim();
  return repository && repository !== 'all' ? repository : null;
}

function hasActiveAuditReportFilters(filters: AuditReportFilters): boolean {
  return filters.severity !== 'all' || filters.state !== 'all' || filters.repository !== null;
}

export function getAuditReportRepositoryOptions(findings: SecurityFindingAuditSection[]): string[] {
  return [
    ...new Set(
      findings
        .map(finding => finding.repository)
        .filter((repository): repository is string => Boolean(repository))
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function normalizeAuditReportRepositoryFilter(
  filters: AuditReportFilters,
  repositoryOptions: readonly string[]
): AuditReportFilters {
  if (filters.repository === null || repositoryOptions.includes(filters.repository)) return filters;
  return { ...filters, repository: null };
}

export function filterSecurityAgentAuditReport(
  report: SecurityAgentAuditReport,
  filters: AuditReportFilters
): SecurityAgentAuditReport {
  if (!hasActiveAuditReportFilters(filters)) return report;

  const findings = report.findings.filter(finding => {
    const matchesSeverity = filters.severity === 'all' || finding.severity === filters.severity;
    const displayState = getFindingDisplayState(finding);
    const matchesState =
      filters.state === 'all' ||
      displayState === filters.state ||
      (filters.state === 'ignored' && displayState === 'dismissed');
    const matchesRepository =
      filters.repository === null || finding.repository === filters.repository;
    return matchesSeverity && matchesState && matchesRepository;
  });
  const bySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  } satisfies SecurityAgentAuditReport['summary']['bySeverity'];
  const byAction: Record<string, number> = {};
  let activityCount = 0;

  for (const finding of findings) {
    if (finding.severity !== 'unknown') bySeverity[finding.severity] += 1;
    activityCount += finding.events.length;
    for (const event of finding.events) {
      byAction[event.action] = (byAction[event.action] ?? 0) + 1;
    }
  }

  return {
    ...report,
    hasLegacySupplementalActivity: findings.some(finding => finding.hasLegacySupplementalActivity),
    summary: {
      findingCount: findings.length,
      activityCount,
      bySeverity,
      byAction,
    },
    findings,
  };
}

function isValidAuditReportDateRange(range: DateRange, now = new Date()): boolean {
  const dayPickerRange = toDayPickerDateRange(range);
  if (!dayPickerRange?.from || !dayPickerRange.to) return false;
  return (
    isWithinAuditReportRangeLimit(dayPickerRange) &&
    dayPickerRange.to.getTime() <= utcDateAsLocalCalendarDate(now).getTime()
  );
}

function toDayPickerDateRange(range: DateRange): DayPickerDateRange | undefined {
  const from = parseDateOnlyAsLocalCalendarDate(range.startDate);
  const to = parseDateOnlyAsLocalCalendarDate(range.endDate);
  if (!from || !to) return undefined;
  return { from, to };
}

function toAuditReportDateRange(range: DayPickerDateRange | undefined): DateRange | null {
  if (!range?.from || !range.to || !isWithinAuditReportRangeLimit(range)) return null;
  return {
    startDate: formatLocalCalendarDateAsUtcDate(range.from),
    endDate: formatLocalCalendarDateAsUtcDate(range.to),
  };
}

function isWithinAuditReportRangeLimit(range: DayPickerDateRange): boolean {
  if (!range.from || !range.to) return false;
  const inclusiveDays = differenceInCalendarDays(range.to, range.from) + 1;
  return inclusiveDays >= 1 && inclusiveDays <= MAX_AUDIT_REPORT_DAYS;
}

function parseDateOnlyAsLocalCalendarDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

function formatLocalCalendarDateAsUtcDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function utcDateAsLocalCalendarDate(value: Date): Date {
  return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function formatDayPickerDateRange(range: DayPickerDateRange | undefined): string {
  if (!range?.from) return 'Select date range';
  const from = formatCalendarDateLabel(range.from, 'MMM d, yyyy');
  if (!range.to) return `${from} - Select end date`;
  return `${from} - ${formatCalendarDateLabel(range.to, 'MMM d, yyyy')}`;
}

export function getDefaultAuditReportDateRange(now = new Date()): DateRange {
  const end = startOfUtcDay(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 89);
  return {
    startDate: formatDateInput(start),
    endDate: formatDateInput(end),
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function formatDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return REPORT_DATE_FORMATTER.format(new Date(value));
}

function formatReportDateTime(value: string): string {
  return `${formatDate(value)} at ${formatAuditEventTime(value)}`;
}

function formatDateTime(value: string): string {
  return REPORT_DATE_TIME_FORMATTER.format(new Date(value));
}

export function formatDateTime24Hour(value: string): string {
  return REPORT_DATE_TIME_24_HOUR_FORMATTER.format(new Date(value));
}

export function formatAuditEventTime(value: string): string {
  return AUDIT_EVENT_TIME_FORMATTER.format(new Date(value));
}

function formatFindingSource(finding: SecurityFindingAuditSection): string {
  if (!finding.source) return 'Not recorded';
  if (finding.source === 'dependabot') {
    return finding.sourceId ? `Dependabot alert #${finding.sourceId}` : 'Dependabot';
  }
  return titleCase(finding.source);
}

export function getAuditReportRepositoryHref(repository: string | null): string | null {
  if (!repository) return null;
  const segments = repository.split('/');
  if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
    return null;
  }
  return `https://github.com/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}

function formatFindingPackage(finding: SecurityFindingAuditSection): string {
  if (!finding.packageName) return 'Not recorded';
  if (!finding.packageEcosystem) return finding.packageName;
  return `${finding.packageName} (${formatPackageEcosystem(finding.packageEcosystem)})`;
}

function formatPackageEcosystem(ecosystem: string): string {
  const knownEcosystems: Record<string, string> = {
    npm: 'npm',
    maven: 'Maven',
    nuget: 'NuGet',
    pip: 'pip',
    rubygems: 'RubyGems',
    composer: 'Composer',
    go_modules: 'Go modules',
    github_actions: 'GitHub Actions',
  };
  return knownEcosystems[ecosystem] ?? titleCase(ecosystem);
}

const EVIDENCE_VALUE_LABELS: Record<string, Record<string, string>> = {
  analysis_status: {
    unknown: 'Previous state unavailable',
    pending: 'Pending',
    running: 'In progress',
    completed: 'Completed',
    failed: 'Failed',
  },
  blocked_reason_code: {
    COVERED_BY_EXISTING_REMEDIATION_PR:
      'An existing remediation pull request already covers this package',
    blocked: 'Remediation could not proceed',
  },
  confidence: {
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  },
  failure_code: {
    analysis_failed: 'Analysis did not complete',
    QUEUE_ADMISSION_FAILED: 'Remediation could not be queued',
    ACTOR_RESOLUTION_FAILED: 'Remediation requester could not be resolved',
    INSUFFICIENT_CREDITS: 'Insufficient credits to start remediation',
    LAUNCH_UPSTREAM_5XX: 'Remediation service was temporarily unavailable',
    CLOUD_AGENT_INTERRUPTED: 'Remediation run was interrupted',
    CLOUD_AGENT_FAILED: 'Cloud Agent could not complete remediation',
    INVALID_PR_OUTCOME: 'Pull request outcome could not be verified',
    MISSING_REMEDIATION_RESULT: 'Remediation result was unavailable',
  },
  is_exploitable: {
    true: 'Exploitable',
    false: 'Not exploitable',
    unknown: 'Unknown',
  },
  origin: {
    manual: 'Manually',
    auto_policy: 'Automatically by policy',
    bulk_existing: 'Automatically for existing findings',
  },
  reason_code: {
    not_used: 'Vulnerable code is not used',
    tolerable_risk: 'Risk accepted',
    inaccurate: 'Finding is inaccurate',
    no_bandwidth: 'Deferred due to capacity',
    superseded: 'Superseded by another finding',
  },
  remediation_status: {
    queued: 'Requested',
    launching: 'Starting',
    running: 'In progress',
    pr_opened: 'Pull request opened',
    failed: 'Failed',
    blocked: 'Blocked',
    no_changes_needed: 'No changes needed',
    cancelled: 'Cancelled',
  },
  severity: {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  },
  source_state: {
    open: 'Open',
    fixed: 'Fixed',
    dismissed: 'Dismissed',
    auto_dismissed: 'Automatically dismissed',
  },
  status: {
    open: 'Open',
    fixed: 'Fixed',
    ignored: 'Dismissed',
  },
  structured_extraction_status: {
    succeeded: 'Available',
    failed: 'Unavailable',
  },
  suggested_action: {
    dismiss: 'Dismiss finding',
    analyze_codebase: 'Analyze codebase',
    manual_review: 'Manual review',
    open_pr: 'Open remediation pull request',
    monitor: 'Monitor',
  },
};

const INTERNAL_DETAIL_FALLBACK_FIELDS = new Set([
  'blocked_reason_code',
  'failure_code',
  'reason_code',
]);

const USER_FACING_TOKEN_FIELDS = new Set(Object.keys(EVIDENCE_VALUE_LABELS));

const DATE_FIELD_PATTERN = /(^|_)(at|date|deadline|cutoff|through|start|end)$/i;

function formatEvidenceScalar(value: unknown, fieldKey: string): string {
  if (value === null || value === undefined) return 'Not recorded';
  if (typeof value === 'boolean') {
    if (fieldKey === 'is_exploitable') {
      return EVIDENCE_VALUE_LABELS.is_exploitable[String(value)] ?? 'Unknown';
    }
    if (fieldKey === 'pr_draft') return value ? 'Draft' : 'Ready for review';
    if (fieldKey === 'deleted') return value ? 'Deleted' : 'Active';
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    if (fieldKey === 'pr_number' || fieldKey === 'source_alert_number') return `#${value}`;
    return value.toLocaleString();
  }
  if (typeof value !== 'string') return String(value);

  const trimmed = value.trim();
  if (!trimmed) return 'Not recorded';

  if (DATE_FIELD_PATTERN.test(fieldKey) && isValidDateString(trimmed)) {
    return trimmed.length <= 10 ? formatDate(trimmed) : formatDateTime(trimmed);
  }

  const knownValue = EVIDENCE_VALUE_LABELS[fieldKey]?.[trimmed];
  if (knownValue) return knownValue;
  if (INTERNAL_DETAIL_FALLBACK_FIELDS.has(fieldKey)) return 'Additional details unavailable';
  if (USER_FACING_TOKEN_FIELDS.has(fieldKey)) return 'Unknown';

  return trimmed;
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, first => first.toUpperCase());
}

function isValidDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function slaLabel(sla: SecurityFindingAuditSection['sla']): string {
  if (sla.status === 'unknown') return 'Unknown';
  if (sla.status === 'terminal_met') return 'Terminal before deadline';
  if (sla.status === 'terminal_missed') return 'Terminal after deadline';
  if (sla.status === 'open_within_deadline') return 'Open before deadline';
  return 'Open past deadline';
}
