'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarDays, format as formatCalendarDateLabel } from 'date-fns';
import { CalendarDays, ExternalLink, FileClock, Info, Loader2, RefreshCw } from 'lucide-react';
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
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
import { SeverityBadge } from './SeverityBadge';
import { FindingStatusBadge } from './FindingStatusBadge';
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
type AuditReportStateFilter = 'all' | 'open' | 'fixed' | 'ignored';

export type AuditReportFilters = {
  severity: AuditReportSeverityFilter;
  state: AuditReportStateFilter;
  repository: string | null;
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const FINDING_SUPERSEDED_ACTION = 'security.finding.superseded';
const MAX_AUDIT_REPORT_DAYS = 90;
const MAX_AUDIT_REPORT_RANGE_NIGHTS = MAX_AUDIT_REPORT_DAYS - 1;

export function SecurityAuditReportPage() {
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isOrg, organizationId, hasIntegration, isLoadingPermission, isLoadingConfig, hasConfig } =
    useSecurityAgent();
  const initialRange = useMemo(() => {
    const fromUrl = {
      startDate: searchParams.get('startDate') ?? '',
      endDate: searchParams.get('endDate') ?? '',
    };
    if (isValidAuditReportDateRange(fromUrl)) return fromUrl;
    return defaultDateRange();
  }, [searchParams]);
  const initialFilters = useMemo(() => parseAuditReportFilters(searchParams), [searchParams]);
  const [draftRange, setDraftRange] = useState<DayPickerDateRange | undefined>(() =>
    toDayPickerDateRange(initialRange)
  );
  const [submittedRange, setSubmittedRange] = useState<DateRange>(initialRange);
  const [draftFilters, setDraftFilters] = useState<AuditReportFilters>(initialFilters);
  const [submittedFilters, setSubmittedFilters] = useState<AuditReportFilters>(initialFilters);
  const [isRangePickerOpen, setIsRangePickerOpen] = useState(false);
  const completeDraftRange = toAuditReportDateRange(draftRange);
  const latestSelectableDate = utcDateAsLocalCalendarDate(new Date());
  const hasOwnerContext = !isOrg || Boolean(organizationId);

  const queryOptions = isOrg
    ? trpc.organizations.securityAgent.getAuditReport.queryOptions({
        organizationId: organizationId ?? '',
        ...submittedRange,
      })
    : trpc.securityAgent.getAuditReport.queryOptions(submittedRange);

  const reportQuery = useQuery({
    ...queryOptions,
    enabled: hasOwnerContext && hasIntegration && hasConfig,
  });

  const unfilteredReport = reportQuery.data?.status === 'ok' ? reportQuery.data.report : null;
  const report = useMemo(
    () =>
      unfilteredReport ? filterSecurityAgentAuditReport(unfilteredReport, submittedFilters) : null,
    [submittedFilters, unfilteredReport]
  );
  const repositoryOptions = useMemo(
    () =>
      getAuditReportRepositoryOptions(unfilteredReport?.findings ?? [], draftFilters.repository),
    [draftFilters.repository, unfilteredReport]
  );
  const configHref =
    isOrg && organizationId
      ? `/organizations/${organizationId}/security-agent/config`
      : '/security-agent/config';
  const isSetupStateLoading = !hasOwnerContext || isLoadingPermission || isLoadingConfig;
  const shouldRedirectToConfig =
    hasOwnerContext &&
    ((!isLoadingPermission && !hasIntegration) || (!isLoadingConfig && !hasConfig));

  useEffect(() => {
    if (shouldRedirectToConfig) {
      router.replace(configHref);
    }
  }, [configHref, router, shouldRedirectToConfig]);

  function handleGenerateReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!completeDraftRange) return;
    setSubmittedRange(completeDraftRange);
    setSubmittedFilters(draftFilters);
  }

  function handleDateRangeSelect(nextRange: DayPickerDateRange | undefined) {
    if (nextRange?.from && nextRange.to && !isWithinAuditReportRangeLimit(nextRange)) return;
    setDraftRange(nextRange);
    if (nextRange?.from && nextRange.to) setIsRangePickerOpen(false);
  }

  return (
    <div className="space-y-4">
      {shouldRedirectToConfig && (
        <div className="text-muted-foreground block py-16 text-center text-sm">
          Opening settings...
        </div>
      )}

      {!shouldRedirectToConfig && isSetupStateLoading && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading audit report...
        </div>
      )}

      {!shouldRedirectToConfig && !isSetupStateLoading && (
        <form
          aria-label="Audit report filters"
          onSubmit={handleGenerateReport}
          className="border-border bg-card/40 grid gap-3 rounded-xl border p-3 md:grid-cols-2 xl:grid-cols-[minmax(18rem,2fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(12rem,1.25fr)_auto] xl:items-end"
        >
          <div className="grid grid-rows-[1rem_2.25rem] gap-1 md:col-span-2 xl:col-span-1">
            <Label htmlFor="audit-report-date-range" className="h-4 text-xs">
              Date range
            </Label>
            <Popover open={isRangePickerOpen} onOpenChange={setIsRangePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  id="audit-report-date-range"
                  type="button"
                  variant="outline"
                  aria-invalid={Boolean(draftRange?.from && !completeDraftRange)}
                  className="h-9 w-full justify-start text-left font-normal"
                >
                  <CalendarDays className="size-4" aria-hidden="true" />
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
                <p className="border-border text-muted-foreground border-t px-3 py-2 text-xs">
                  Select up to {MAX_AUDIT_REPORT_DAYS} calendar days in UTC.
                </p>
              </PopoverContent>
            </Popover>
          </div>
          <div className="grid grid-rows-[1rem_2.25rem] gap-1">
            <Label htmlFor="audit-report-severity" className="h-4 text-xs">
              Severity
            </Label>
            <Select
              value={draftFilters.severity}
              onValueChange={severity =>
                setDraftFilters(current => ({
                  ...current,
                  severity: parseAuditReportSeverityFilter(severity),
                }))
              }
            >
              <SelectTrigger id="audit-report-severity" className="w-full">
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
          </div>
          <div className="grid grid-rows-[1rem_2.25rem] gap-1">
            <Label htmlFor="audit-report-state" className="h-4 text-xs">
              State
            </Label>
            <Select
              value={draftFilters.state}
              onValueChange={state =>
                setDraftFilters(current => ({
                  ...current,
                  state: parseAuditReportStateFilter(state),
                }))
              }
            >
              <SelectTrigger id="audit-report-state" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="fixed">Fixed</SelectItem>
                <SelectItem value="ignored">Dismissed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-rows-[1rem_2.25rem] gap-1">
            <Label htmlFor="audit-report-repository" className="h-4 text-xs">
              Repository
            </Label>
            <Select
              value={draftFilters.repository ?? 'all'}
              onValueChange={repository =>
                setDraftFilters(current => ({
                  ...current,
                  repository: parseAuditReportRepositoryFilter(repository),
                }))
              }
            >
              <SelectTrigger id="audit-report-repository" className="w-full">
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
          </div>
          <div className="flex flex-col gap-2 sm:flex-row md:self-end md:justify-end">
            <Button
              type="submit"
              disabled={reportQuery.isFetching || !completeDraftRange}
              className="w-full sm:w-fit"
            >
              <RefreshCw
                className={cn(
                  'size-4',
                  reportQuery.isFetching && 'animate-spin motion-reduce:animate-none'
                )}
                aria-hidden="true"
              />
              Generate report
            </Button>
          </div>
        </form>
      )}

      {!shouldRedirectToConfig && !isSetupStateLoading && reportQuery.isLoading && (
        <AuditReportSkeleton />
      )}

      {!shouldRedirectToConfig && !isSetupStateLoading && reportQuery.isError && (
        <Alert variant="destructive">
          <Info className="size-4" aria-hidden="true" />
          <AlertTitle>Audit report could not be loaded</AlertTitle>
          <AlertDescription>Check your connection and generate the report again.</AlertDescription>
        </Alert>
      )}

      {!shouldRedirectToConfig &&
        !isSetupStateLoading &&
        reportQuery.data?.status === 'query_failed' && (
          <Alert variant="warning">
            <Info className="size-4" aria-hidden="true" />
            <AlertTitle>Report query did not finish</AlertTitle>
            <AlertDescription>
              Choose a shorter date range and generate the report again.
            </AlertDescription>
          </Alert>
        )}

      {!shouldRedirectToConfig && !isSetupStateLoading && report && (
        <AuditReportView
          report={report}
          hasActiveFilters={hasActiveAuditReportFilters(submittedFilters)}
        />
      )}
    </div>
  );
}

function AuditReportView({
  report,
  hasActiveFilters,
}: {
  report: SecurityAgentAuditReport;
  hasActiveFilters: boolean;
}) {
  return (
    <div className="space-y-4">
      <ReportOverview report={report} />

      {report.findings.length === 0 ? (
        <AuditReportEmptyState
          startDate={formatDate(report.period.start)}
          endDate={formatDate(report.period.displayEnd)}
          hasActiveFilters={hasActiveFilters}
        />
      ) : (
        <FindingTimelineList findings={report.findings} />
      )}
    </div>
  );
}

function ReportOverview({ report }: { report: SecurityAgentAuditReport }) {
  const supersededCount = report.summary.byAction[FINDING_SUPERSEDED_ACTION] ?? 0;

  return (
    <section className="border-border rounded-xl border p-4" aria-label="Report summary">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <OverviewMetric label="Findings" value={report.summary.findingCount} />
        <OverviewMetric label="Events" value={report.summary.activityCount} />
        {supersededCount > 0 && <OverviewMetric label="Superseded" value={supersededCount} />}
        {SEVERITY_ORDER.map(severity => {
          const count = report.summary.bySeverity[severity];
          if (count === 0) return null;
          return <OverviewMetric key={severity} label={titleCase(severity)} value={count} />;
        })}
      </div>
    </section>
  );
}

function OverviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20">
      <div className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function AuditReportEmptyState({
  startDate,
  endDate,
  hasActiveFilters,
}: {
  startDate: string;
  endDate: string;
  hasActiveFilters: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 p-6">
        <div className="bg-muted text-muted-foreground mt-1 flex size-10 shrink-0 items-center justify-center rounded-md">
          <FileClock className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-1">
          <h1 className="text-base leading-6 font-semibold">
            {hasActiveFilters ? 'No findings match selected filters' : 'No audit report data yet'}
          </h1>
          <p className="text-muted-foreground text-sm leading-5">
            {hasActiveFilters
              ? `No Security Findings with recorded activity from ${startDate} to ${endDate} match selected report filters.`
              : `Kilo has not recorded reportable Security Finding activity from ${startDate} to ${endDate}. Try another date range after Security Agent syncs findings.`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function FindingTimelineList({ findings }: { findings: SecurityFindingAuditSection[] }) {
  return (
    <div className="border-border overflow-hidden rounded-xl border">
      <div
        className="border-border bg-muted/15 text-muted-foreground hidden grid-cols-[minmax(0,1fr)_8rem_11rem] gap-4 border-b py-2 pr-4 pl-10 text-[11px] font-medium xl:grid"
        aria-hidden="true"
      >
        <span>Finding</span>
        <span>State</span>
        <span>Latest activity</span>
      </div>
      <Accordion type="multiple">
        {findings.map(finding => (
          <AccordionItem
            key={finding.findingId}
            value={finding.findingId}
            className="[&>[data-slot=accordion-content]]:mt-0"
          >
            <AccordionTrigger className="hover:bg-muted/30 data-[state=open]:bg-muted/20 min-h-11 items-center rounded-none px-4 py-3 hover:no-underline [&>svg]:translate-y-0">
              <FindingSummary finding={finding} />
            </AccordionTrigger>
            <AccordionContent className="border-border bg-muted/10 border-t px-4 py-5 md:px-6 xl:px-8">
              <FindingDetails finding={finding} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

function FindingSummary({ finding }: { finding: SecurityFindingAuditSection }) {
  const latestEvent = finding.events[finding.events.length - 1];
  const eventCountLabel = `${finding.events.length.toLocaleString()} ${finding.events.length === 1 ? 'event' : 'events'}`;

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_8rem_11rem] md:items-center md:gap-4">
      <div className="col-span-2 min-w-0 md:col-span-1 md:col-start-1 md:row-start-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex w-16 shrink-0 items-center">
            {finding.severity !== 'unknown' && (
              <SeverityBadge severity={finding.severity} size="sm" />
            )}
          </div>
          <span className="min-w-0 break-words text-sm leading-5 font-medium">{finding.title}</span>
        </div>
      </div>

      <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 md:col-start-2 md:row-start-1 md:justify-start">
        {finding.status && <FindingStatusBadge status={finding.status} />}
        {finding.deleted && <Badge variant="outline">Deleted</Badge>}
      </div>

      <div className="col-start-2 row-start-2 min-w-0 text-right md:col-start-3 md:row-start-1 md:text-left">
        {latestEvent && (
          <div className="truncate text-xs font-medium" title={latestEvent.label}>
            {latestEvent.label}
          </div>
        )}
        <div className="text-muted-foreground mt-0.5 text-xs leading-4 tabular-nums">
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

function FindingDetails({ finding }: { finding: SecurityFindingAuditSection }) {
  return (
    <div className="security-agent-finding-details grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-4">
        <h3 className="text-sm font-semibold">Events</h3>
        <div>
          {finding.events.map((event, index) => (
            <AuditEventRow
              key={event.id}
              event={event}
              isLast={index === finding.events.length - 1}
            />
          ))}
        </div>
      </div>
      <FindingMetadata finding={finding} />
    </div>
  );
}

function FindingMetadata({ finding }: { finding: SecurityFindingAuditSection }) {
  const advisoryReferences = [finding.cveId, finding.ghsaId].filter((value): value is string =>
    Boolean(value)
  );

  return (
    <aside
      className="bg-muted/30 min-w-0 rounded-lg p-4 lg:rounded-none lg:border-l lg:border-border lg:p-5"
      aria-label="Finding details"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <Definition
          label="Source"
          value={formatFindingSource(finding)}
          href={finding.dependabotUrl}
        />
        <Definition
          label="Repository"
          value={finding.repository ?? 'Not recorded'}
          href={getAuditReportRepositoryHref(finding.repository)}
        />
        <Definition label="Package" value={formatFindingPackage(finding)} />
        <Definition label="Manifest" value={finding.manifestPath ?? 'Not recorded'} />
        <Definition
          label="First detected"
          value={finding.firstDetectedAt ? formatDateTime(finding.firstDetectedAt) : 'Unknown'}
        />
        <Definition label="SLA status" value={slaLabel(finding.sla)} />
        <Definition
          label="SLA deadline"
          value={finding.sla.deadline ? formatDateTime24Hour(finding.sla.deadline) : 'Unknown'}
        />
        {(advisoryReferences.length > 0 || finding.cvssScore !== null) && (
          <AdvisoryMetadata references={advisoryReferences} cvssScore={finding.cvssScore} />
        )}
        {finding.patchedVersion && (
          <Definition label="Patched version" value={finding.patchedVersion} />
        )}
      </div>
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
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-6 last:pb-0 sm:grid-cols-[8.5rem_1rem_minmax(0,1fr)]">
      <time
        dateTime={event.occurredAt}
        className="text-muted-foreground col-start-2 row-start-1 mb-2 flex flex-wrap gap-x-1.5 text-xs leading-4 tabular-nums sm:col-start-1 sm:mb-0 sm:block sm:pr-1 sm:text-right"
      >
        <span className="sm:block">{formatDate(event.occurredAt)}</span>
        <span className="sm:mt-0.5 sm:block">{formatAuditEventTime(event.occurredAt)}</span>
      </time>

      <div
        className="relative col-start-1 row-span-2 row-start-1 flex justify-center sm:col-start-2"
        aria-hidden="true"
      >
        {!isLast && <span className="bg-border absolute top-3 -bottom-6 w-px" />}
        <span className="bg-card border-border relative mt-1 size-2.5 rounded-full border" />
      </div>

      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-span-2 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{event.label}</span>
          {event.legacySupplemental && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Legacy event information"
                  className="text-muted-foreground focus-visible:ring-ring inline-flex rounded-full focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Info className="size-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                This event comes from an older record mapped to this finding. Earlier activity may
                be incomplete.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="text-muted-foreground mt-1 text-xs">{event.actor.displayName}</div>
        <EventDetails event={event} />
      </div>
    </div>
  );
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
    <dl className="border-border mt-3 flex flex-wrap gap-x-6 gap-y-3 border-t pt-3 text-xs">
      {details.map(detail => (
        <div key={detail.label} className="min-w-24 space-y-1">
          <dt className="text-muted-foreground text-[11px] font-medium">{detail.label}</dt>
          <dd className="break-words">
            {detail.href ? (
              <a
                href={detail.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm underline underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:outline-none"
              >
                {detail.value}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
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

function Definition({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string | null;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-visible:ring-ring inline-flex max-w-full items-center gap-1 rounded-sm text-sm underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="min-w-0 break-words">{value}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>
      ) : (
        <div className="break-words text-sm">{value}</div>
      )}
    </div>
  );
}

function AdvisoryMetadata({
  references,
  cvssScore,
}: {
  references: string[];
  cvssScore: SecurityFindingAuditSection['cvssScore'];
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-muted-foreground text-xs font-medium">Advisory</div>
      <div className="flex flex-wrap gap-1.5">
        {references.map(reference => (
          <Badge key={reference} variant="outline" className="font-mono font-normal">
            {reference}
          </Badge>
        ))}
        {cvssScore !== null && (
          <Badge variant="secondary" className="font-normal">
            CVSS {cvssScore}
          </Badge>
        )}
      </div>
    </div>
  );
}

function AuditReportSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

type SearchParamsReader = {
  get(name: string): string | null;
};

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
  if (value === 'open' || value === 'fixed' || value === 'ignored') return value;
  return 'all';
}

function parseAuditReportRepositoryFilter(value: string | null): string | null {
  const repository = value?.trim();
  return repository && repository !== 'all' ? repository : null;
}

function hasActiveAuditReportFilters(filters: AuditReportFilters): boolean {
  return filters.severity !== 'all' || filters.state !== 'all' || filters.repository !== null;
}

export function getAuditReportRepositoryOptions(
  findings: SecurityFindingAuditSection[],
  selectedRepository: string | null
): string[] {
  const repositories = new Set(
    findings
      .map(finding => finding.repository)
      .filter((repository): repository is string => Boolean(repository))
  );
  if (selectedRepository) repositories.add(selectedRepository);
  return [...repositories].sort((left, right) => left.localeCompare(right));
}

export function filterSecurityAgentAuditReport(
  report: SecurityAgentAuditReport,
  filters: AuditReportFilters
): SecurityAgentAuditReport {
  if (!hasActiveAuditReportFilters(filters)) return report;

  const findings = report.findings.filter(finding => {
    const matchesSeverity = filters.severity === 'all' || finding.severity === filters.severity;
    const matchesState = filters.state === 'all' || finding.status === filters.state;
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

function defaultDateRange(): DateRange {
  const now = new Date();
  const end = startOfUtcDay(now);
  end.setUTCDate(end.getUTCDate() - 1);
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
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function formatDateTime24Hour(value: string): string {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}

export function formatAuditEventTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
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
