'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
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
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { SeverityBadge } from '@/components/security-agent/SeverityBadge';
import { cn } from '@/lib/utils';
import { toneStyles, type Tone } from './FindingStoryShell';

const meta: Meta<typeof AuditReportStory> = {
  title: 'Security Agent/Audit Report',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Document-oriented Security Agent Audit Report with recorded evidence, owner and coverage provenance, compact filters, finding groups, and chronological activity.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;
type Severity = 'critical' | 'high' | 'medium' | 'low';
type FindingState = 'open' | 'fixed' | 'dismissed' | 'superseded' | 'deleted';
type SeverityFilter = 'all' | Severity;
type StateFilter = 'all' | FindingState;
type ReportViewState = 'ready' | 'loading' | 'failure';

type ReportFilters = {
  severity: SeverityFilter;
  state: StateFilter;
  repository: string;
};

type DateRangePreset = {
  id: string;
  label: string;
  compactLabel: string;
  start: string;
  end: string;
};

type EventDetail = {
  label: string;
  value: string;
  previousValue?: string;
  mono?: boolean;
  href?: string;
};

type AuditEvent = {
  id: string;
  label: string;
  occurredAt: string;
  recordedSeverity: Severity;
  recordedState: FindingState;
  date: string;
  time: string;
  actor: string;
  actorReference?: string;
  icon: LucideIcon;
  tone: Tone;
  details: EventDetail[];
  legacy?: boolean;
};

type SlaEvidence = {
  label: string;
  deadline: string;
  tone: Tone;
};

type AuditFinding = {
  id: string;
  title: string;
  repository: string;
  severity: Severity;
  state: FindingState;
  source: string;
  sourceHref: string;
  packageName: string;
  packageEcosystem: string;
  manifest: string;
  firstDetected: string;
  advisories: string[];
  cvss: string | null;
  patchedVersion: string | null;
  canonicalFindingId?: string;
  sla: SlaEvidence;
  events: AuditEvent[];
};

const defaultDateRange: DateRangePreset = {
  id: '90-days',
  label: 'Mar 20, 2026 to Jun 17, 2026',
  compactLabel: 'Mar 20 - Jun 17, 2026',
  start: '2026-03-20',
  end: '2026-06-17',
};

const dateRanges = [
  defaultDateRange,
  {
    id: '17-days',
    label: 'Jun 1, 2026 to Jun 17, 2026',
    compactLabel: 'Jun 1 - Jun 17, 2026',
    start: '2026-06-01',
    end: '2026-06-17',
  },
  {
    id: 'today',
    label: 'Jun 17, 2026',
    compactLabel: 'Jun 17, 2026',
    start: '2026-06-17',
    end: '2026-06-17',
  },
] satisfies DateRangePreset[];

const severityOptions = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] satisfies Array<{ value: SeverityFilter; label: string }>;

const stateOptions = [
  { value: 'all', label: 'All states' },
  { value: 'open', label: 'Open' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'deleted', label: 'Deleted' },
] satisfies Array<{ value: StateFilter; label: string }>;

const allFilters: ReportFilters = {
  severity: 'all',
  state: 'all',
  repository: 'all',
};

const reportFindings: AuditFinding[] = [
  {
    id: 'sf_01JXTSQ48V8Y0J59N9QK7M2A4P',
    title: 'Remote code execution through vulnerable workflow dependency',
    repository: 'Kilo-Org/cloud',
    severity: 'critical',
    state: 'open',
    source: 'Dependabot alert #42',
    sourceHref: 'https://github.com/Kilo-Org/cloud/security/dependabot/42',
    packageName: 'workflow-core',
    packageEcosystem: 'npm',
    manifest: 'services/runner/package-lock.json',
    firstDetected: 'Jun 12, 2026 at 09:14 UTC',
    advisories: ['CVE-2026-10418', 'GHSA-4g3p-x9qv-8m2c'],
    cvss: '9.8',
    patchedVersion: '3.8.2',
    sla: {
      label: 'Open past deadline',
      deadline: 'Jun 14, 2026 at 09:14 UTC',
      tone: 'destructive',
    },
    events: [
      {
        id: 'event-critical-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T09:14:00.000Z',
        recordedSeverity: 'critical',
        recordedState: 'open',
        date: 'Jun 12, 2026',
        time: '09:14 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'Critical' },
          { label: 'State', value: 'Open' },
          { label: 'Dependabot alert', value: '#42', mono: true },
        ],
      },
      {
        id: 'event-critical-analysis',
        label: 'Analysis completed',
        occurredAt: '2026-06-15T14:50:00.000Z',
        recordedSeverity: 'critical',
        recordedState: 'open',
        date: 'Jun 15, 2026',
        time: '14:50 UTC',
        actor: 'Kilo system',
        icon: Brain,
        tone: 'destructive',
        details: [
          { label: 'Exploitability', value: 'Exploitable' },
          { label: 'Recommended next step', value: 'Open remediation pull request' },
        ],
      },
      {
        id: 'event-critical-remediation',
        label: 'Remediation requested',
        occurredAt: '2026-06-15T17:01:00.000Z',
        recordedSeverity: 'critical',
        recordedState: 'open',
        date: 'Jun 15, 2026',
        time: '17:01 UTC',
        actor: 'Jordan Park',
        actorReference: 'user:usr_01JXK92T4F',
        icon: UserRound,
        tone: 'neutral',
        details: [
          { label: 'Attempt', value: '1' },
          { label: 'Requested', value: 'Manually' },
        ],
      },
      {
        id: 'event-critical-pr',
        label: 'PR opened',
        occurredAt: '2026-06-15T17:05:00.000Z',
        recordedSeverity: 'critical',
        recordedState: 'open',
        date: 'Jun 15, 2026',
        time: '17:05 UTC',
        actor: 'Cloud Agent',
        icon: GitPullRequest,
        tone: 'success',
        details: [
          {
            label: 'Pull request',
            value: '#184',
            mono: true,
            href: 'https://github.com/Kilo-Org/cloud/pull/184',
          },
          { label: 'Review state', value: 'Ready for review' },
          { label: 'Validation checks', value: '3' },
        ],
      },
    ],
  },
  {
    id: 'sf_01JXTT4NV3G7Y3D5B4V2M8J6CQ',
    title: 'Command Injection in lodash',
    repository: 'Kilo-Org/security-agent-testbed',
    severity: 'high',
    state: 'dismissed',
    source: 'Dependabot alert #18',
    sourceHref: 'https://github.com/Kilo-Org/security-agent-testbed/security/dependabot/18',
    packageName: 'lodash',
    packageEcosystem: 'npm',
    manifest: 'package-lock.json',
    firstDetected: 'Mar 4, 2026 at 09:12 UTC',
    advisories: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'],
    cvss: '7.2',
    patchedVersion: '4.17.21',
    sla: {
      label: 'Terminal before deadline',
      deadline: 'Jul 11, 2026 at 09:12 UTC',
      tone: 'success',
    },
    events: [
      {
        id: 'event-lodash-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T11:28:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'open',
        date: 'Jun 12, 2026',
        time: '11:28 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'High' },
          { label: 'State', value: 'Open' },
          { label: 'Dependabot alert', value: '#18', mono: true },
        ],
      },
      {
        id: 'event-lodash-analysis',
        label: 'Analysis completed',
        occurredAt: '2026-06-15T15:02:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'open',
        date: 'Jun 15, 2026',
        time: '15:02 UTC',
        actor: 'Kilo system',
        icon: ShieldCheck,
        tone: 'success',
        details: [
          { label: 'Exploitability', value: 'Not exploitable' },
          { label: 'Recommended next step', value: 'Dismiss finding' },
        ],
      },
      {
        id: 'event-lodash-dismissed',
        label: 'Dismissed',
        occurredAt: '2026-06-16T20:12:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'dismissed',
        date: 'Jun 16, 2026',
        time: '20:12 UTC',
        actor: 'Jordan Park',
        actorReference: 'user:usr_01JXK92T4F',
        icon: XCircle,
        tone: 'neutral',
        details: [
          { label: 'State', value: 'Dismissed', previousValue: 'Open' },
          { label: 'Reason', value: 'Vulnerable code is not used' },
        ],
      },
    ],
  },
  {
    id: 'sf_01JXTTDS3GMH3F0HTV4QF7JVA1',
    title: "axios's shouldBypassProxy does not recognize IPv4-mapped IPv6 addresses",
    repository: 'Kilo-Org/kilocode',
    severity: 'high',
    state: 'open',
    source: 'Dependabot alert #91',
    sourceHref: 'https://github.com/Kilo-Org/kilocode/security/dependabot/91',
    packageName: 'axios',
    packageEcosystem: 'npm',
    manifest: 'pnpm-lock.yaml',
    firstDetected: 'May 27, 2026 at 18:40 UTC',
    advisories: ['CVE-2025-62718', 'GHSA-4hjh-wcwx-xvwj'],
    cvss: '7.5',
    patchedVersion: '1.12.0',
    sla: {
      label: 'Open before deadline',
      deadline: 'Jun 26, 2026 at 18:40 UTC',
      tone: 'warning',
    },
    events: [
      {
        id: 'event-axios-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T12:08:00.000Z',
        recordedSeverity: 'medium',
        recordedState: 'open',
        date: 'Jun 12, 2026',
        time: '12:08 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'Medium' },
          { label: 'State', value: 'Open' },
        ],
      },
      {
        id: 'event-axios-severity',
        label: 'Severity changed',
        occurredAt: '2026-06-16T08:42:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'open',
        date: 'Jun 16, 2026',
        time: '08:42 UTC',
        actor: 'GitHub Dependabot',
        icon: TriangleAlert,
        tone: 'warning',
        details: [{ label: 'Severity', value: 'High', previousValue: 'Medium' }],
      },
    ],
  },
  {
    id: 'sf_01JXTVEP68Q2B4F0DZ1A9N7KMC',
    title: 'ReDoS in Sec-Websocket-Protocol header',
    repository: 'Kilo-Org/kilocode-landing',
    severity: 'medium',
    state: 'fixed',
    source: 'Dependabot alert #12',
    sourceHref: 'https://github.com/Kilo-Org/kilocode-landing/security/dependabot/12',
    packageName: 'ws',
    packageEcosystem: 'npm',
    manifest: 'package-lock.json',
    firstDetected: 'Apr 19, 2026 at 07:30 UTC',
    advisories: ['CVE-2024-37890', 'GHSA-3h5v-q93c-6h6q'],
    cvss: '6.5',
    patchedVersion: '8.17.1',
    sla: {
      label: 'Terminal before deadline',
      deadline: 'Jul 3, 2026 at 07:30 UTC',
      tone: 'success',
    },
    events: [
      {
        id: 'event-ws-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T13:24:00.000Z',
        recordedSeverity: 'medium',
        recordedState: 'open',
        date: 'Jun 12, 2026',
        time: '13:24 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'Medium' },
          { label: 'State', value: 'Open' },
        ],
      },
      {
        id: 'event-ws-fixed',
        label: 'Status changed',
        occurredAt: '2026-06-16T11:16:00.000Z',
        recordedSeverity: 'medium',
        recordedState: 'fixed',
        date: 'Jun 16, 2026',
        time: '11:16 UTC',
        actor: 'GitHub Dependabot',
        icon: CheckCircle2,
        tone: 'success',
        details: [
          { label: 'State', value: 'Fixed', previousValue: 'Open' },
          { label: 'Fixed', value: 'Jun 16, 2026 at 11:14 UTC' },
        ],
      },
    ],
  },
  {
    id: 'sf_01JXTW2ER8M9Q2Y7HF4KV5Z1PA',
    title: 'Prototype Pollution in minimist',
    repository: 'Kilo-Org/security-agent-testbed',
    severity: 'high',
    state: 'superseded',
    source: 'Dependabot alert #6',
    sourceHref: 'https://github.com/Kilo-Org/security-agent-testbed/security/dependabot/6',
    packageName: 'minimist',
    packageEcosystem: 'npm',
    manifest: 'package-lock.json',
    firstDetected: 'Feb 11, 2026 at 11:07 UTC',
    advisories: ['CVE-2021-44906', 'GHSA-xvch-5gv4-984h'],
    cvss: '7.3',
    patchedVersion: '1.2.6',
    canonicalFindingId: 'sf_01JXTW4HAQ7BWQ0C6MEK9D1F2R',
    sla: {
      label: 'Unknown',
      deadline: 'Not recorded',
      tone: 'neutral',
    },
    events: [
      {
        id: 'event-minimist-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T14:06:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'open',
        date: 'Jun 12, 2026',
        time: '14:06 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'High' },
          { label: 'State', value: 'Open' },
        ],
        legacy: true,
      },
      {
        id: 'event-minimist-superseded',
        label: 'Superseded',
        occurredAt: '2026-06-16T13:48:00.000Z',
        recordedSeverity: 'high',
        recordedState: 'superseded',
        date: 'Jun 16, 2026',
        time: '13:48 UTC',
        actor: 'Kilo system',
        icon: GitMerge,
        tone: 'neutral',
        details: [
          { label: 'State', value: 'Superseded', previousValue: 'Open' },
          { label: 'Reason', value: 'Superseded by another finding' },
        ],
      },
    ],
  },
  {
    id: 'sf_01JXTWJZ82V4AC6X7M0NK9Q3PE',
    title: 'Redirect to untrusted site in got',
    repository: 'Kilo-Org/legacy-console',
    severity: 'low',
    state: 'deleted',
    source: 'Dependabot alert #3',
    sourceHref: 'https://github.com/Kilo-Org/legacy-console/security/dependabot/3',
    packageName: 'got',
    packageEcosystem: 'npm',
    manifest: 'package-lock.json',
    firstDetected: 'Jan 8, 2026 at 12:32 UTC',
    advisories: ['CVE-2022-33987'],
    cvss: '3.7',
    patchedVersion: '11.8.5',
    sla: {
      label: 'Unknown',
      deadline: 'Not recorded',
      tone: 'neutral',
    },
    events: [
      {
        id: 'event-got-imported',
        label: 'Imported',
        occurredAt: '2026-06-12T14:44:00.000Z',
        recordedSeverity: 'low',
        recordedState: 'dismissed',
        date: 'Jun 12, 2026',
        time: '14:44 UTC',
        actor: 'Kilo system',
        icon: Activity,
        tone: 'neutral',
        details: [
          { label: 'Severity', value: 'Low' },
          { label: 'State', value: 'Dismissed' },
        ],
        legacy: true,
      },
      {
        id: 'event-got-deleted',
        label: 'Deleted',
        occurredAt: '2026-06-16T16:30:00.000Z',
        recordedSeverity: 'low',
        recordedState: 'deleted',
        date: 'Jun 16, 2026',
        time: '16:30 UTC',
        actor: 'Jordan Park',
        actorReference: 'user:deleted',
        icon: Trash2,
        tone: 'neutral',
        details: [{ label: 'Previous state', value: 'Dismissed' }],
      },
    ],
  },
];

function AuditReportStory({
  sourceFindings = reportFindings,
  viewState = 'ready',
  initialFilters = allFilters,
  initialExpandedFindingId = reportFindings[0]?.id,
}: {
  sourceFindings?: AuditFinding[];
  viewState?: ReportViewState;
  initialFilters?: ReportFilters;
  initialExpandedFindingId?: string;
}) {
  const [draftFilters, setDraftFilters] = useState(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialFilters);
  const [draftRangeId, setDraftRangeId] = useState(defaultDateRange.id);
  const [appliedRangeId, setAppliedRangeId] = useState(defaultDateRange.id);
  const draftRange = getDateRange(draftRangeId);
  const appliedRange = getDateRange(appliedRangeId);
  const repositories = useMemo(
    () => [...new Set(sourceFindings.map(finding => finding.repository))].sort(),
    [sourceFindings]
  );
  const filteredFindings = useMemo(
    () => filterFindings(sourceFindings, appliedFilters, appliedRange),
    [appliedFilters, appliedRange, sourceFindings]
  );
  const hasActiveFilters =
    appliedFilters.severity !== 'all' ||
    appliedFilters.state !== 'all' ||
    appliedFilters.repository !== 'all';

  function clearFilters() {
    setDraftFilters(allFilters);
    setAppliedFilters(allFilters);
    setDraftRangeId(defaultDateRange.id);
    setAppliedRangeId(defaultDateRange.id);
  }

  return (
    <main className="bg-surface-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-6xl space-y-6">
        <ReportHeader />

        <ReportProvenance range={appliedRange} />

        <ReportFilters
          filters={draftFilters}
          onFiltersChange={setDraftFilters}
          repositories={repositories}
          range={draftRange}
          onRangeChange={setDraftRangeId}
          onGenerate={() => {
            setAppliedFilters(draftFilters);
            setAppliedRangeId(draftRangeId);
          }}
          isLoading={viewState === 'loading'}
        />

        {viewState === 'loading' && <ReportSkeleton />}

        {viewState === 'failure' && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Audit report could not be loaded</AlertTitle>
            <AlertDescription>
              Kilo did not return partial report content. Check your connection and generate the
              report again.
            </AlertDescription>
          </Alert>
        )}

        {viewState === 'ready' && (
          <>
            <CoverageNotice />
            <ReportSummary findings={filteredFindings} />
            {filteredFindings.length > 0 ? (
              <FindingTimelineList
                findings={filteredFindings}
                totalFindingCount={sourceFindings.length}
                initialExpandedFindingId={initialExpandedFindingId}
              />
            ) : (
              <ReportEmptyState
                hasActiveFilters={hasActiveFilters}
                range={appliedRange}
                onClearFilters={clearFilters}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ReportHeader() {
  return (
    <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="flex max-w-3xl flex-col gap-2">
        <div className="text-muted-foreground type-eyebrow">Security Agent audit report</div>
        <h1 className="type-title">Recorded activity</h1>
        <p className="text-muted-foreground type-body max-w-[70ch]">
          Review material Security Finding activity recorded by Kilo for an owner and UTC period.
        </p>
      </div>
      <Badge
        variant="outline"
        className="text-muted-foreground gap-1.5 justify-self-start rounded-full"
      >
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        Activity recorded by Kilo
      </Badge>
    </header>
  );
}

function ReportProvenance({ range }: { range: DateRangePreset }) {
  return (
    <section
      className="border-border bg-surface-raised overflow-hidden rounded-xl border"
      aria-labelledby="report-provenance-title"
    >
      <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <h2 id="report-provenance-title" className="type-body font-medium">
          Report evidence
        </h2>
        <span className="text-muted-foreground type-code tabular-nums">Report v1</span>
      </div>
      <dl className="border-border grid border-t sm:grid-cols-2 lg:grid-cols-4">
        <ReportFact label="Owner" value="Kilo-Org" />
        <ReportFact label="UTC period" value={range.compactLabel} mono />
        <ReportFact label="Data through" value="Jun 17, 2026 at 07:32 UTC" mono />
        <ReportFact label="Reliable coverage" value="From Jun 12, 2026" mono />
      </dl>
    </section>
  );
}

function ReportFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="border-border min-w-0 border-b px-4 py-3 last:border-b-0 sm:px-5 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0">
      <dt className="text-muted-foreground type-label">{label}</dt>
      <dd
        className={cn('type-body mt-1 break-words font-medium', mono && 'type-code tabular-nums')}
      >
        {value}
      </dd>
    </div>
  );
}

function ReportFilters({
  filters,
  onFiltersChange,
  repositories,
  range,
  onRangeChange,
  onGenerate,
  isLoading,
}: {
  filters: ReportFilters;
  onFiltersChange: (filters: ReportFilters) => void;
  repositories: string[];
  range: DateRangePreset;
  onRangeChange: (rangeId: string) => void;
  onGenerate: () => void;
  isLoading: boolean;
}) {
  return (
    <section className="border-border bg-surface-raised rounded-xl border p-4 sm:p-5">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(16rem,1.7fr)_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(13rem,1.25fr)_auto] xl:items-end">
        <div className="space-y-1.5 md:col-span-2 xl:col-span-1">
          <Label htmlFor="audit-report-period" className="type-label">
            Report period
          </Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                id="audit-report-period"
                type="button"
                variant="outline"
                className="type-body w-full justify-start font-normal"
              >
                <CalendarDays aria-hidden="true" />
                <span className="truncate">{range.label}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-2">
              <fieldset className="space-y-1">
                <legend className="sr-only">Report period presets</legend>
                {dateRanges.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onRangeChange(option.id)}
                    className={cn(
                      'focus-visible:ring-ring type-body flex min-h-10 w-full items-center justify-between rounded-md px-3 py-2 text-left outline-none focus-visible:ring-[3px]',
                      option.id === range.id
                        ? 'bg-surface-selected text-foreground'
                        : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                    )}
                  >
                    <span>{option.label}</span>
                    {option.id === range.id && (
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </fieldset>
              <p className="border-border text-muted-foreground type-label mt-2 border-t px-3 pt-2">
                Report periods can include up to 90 calendar days.
              </p>
            </PopoverContent>
          </Popover>
        </div>

        <FilterSelect
          id="audit-report-severity"
          label="Severity"
          value={filters.severity}
          options={severityOptions}
          onValueChange={value =>
            onFiltersChange({ ...filters, severity: parseSeverityFilter(value) })
          }
        />

        <FilterSelect
          id="audit-report-state"
          label="Recorded state"
          value={filters.state}
          options={stateOptions}
          onValueChange={value => onFiltersChange({ ...filters, state: parseStateFilter(value) })}
        />

        <div className="space-y-1.5">
          <Label htmlFor="audit-report-repository" className="type-label">
            Repository
          </Label>
          <Select
            value={filters.repository}
            onValueChange={repository => onFiltersChange({ ...filters, repository })}
          >
            <SelectTrigger id="audit-report-repository" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repositories</SelectItem>
              {repositories.map(repository => (
                <SelectItem key={repository} value={repository}>
                  {repository}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button type="button" onClick={onGenerate} disabled={isLoading} className="w-full xl:w-fit">
          <RefreshCw
            className={cn(isLoading && 'animate-spin motion-reduce:animate-none')}
            aria-hidden="true"
          />
          Generate report
        </Button>
      </div>
    </section>
  );
}

function FilterSelect<T extends string>({
  id,
  label,
  value,
  options,
  onValueChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="type-label">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CoverageNotice() {
  return (
    <div
      className={cn(
        'type-body flex items-start gap-3 rounded-lg border p-4',
        toneStyles.warning.border
      )}
    >
      <Info className="text-status-warning-icon mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">Earlier activity may be incomplete</p>
        <p className="text-muted-foreground mt-1">
          Reliable Security Finding event coverage begins Jun 12, 2026. Mapped legacy activity is
          labeled in each timeline.
        </p>
      </div>
    </div>
  );
}

function ReportSummary({ findings }: { findings: AuditFinding[] }) {
  const summary = summarizeFindings(findings);
  const metrics = [
    { label: 'Findings', value: findings.length },
    { label: 'Events', value: summary.events },
    { label: 'Superseded', value: summary.superseded },
    { label: 'Critical', value: summary.critical },
    { label: 'High', value: summary.high },
    { label: 'Medium', value: summary.medium },
    { label: 'Low', value: summary.low },
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

function FindingTimelineList({
  findings,
  totalFindingCount,
  initialExpandedFindingId,
}: {
  findings: AuditFinding[];
  totalFindingCount: number;
  initialExpandedFindingId?: string;
}) {
  const visibleInitialFinding = findings.some(finding => finding.id === initialExpandedFindingId)
    ? initialExpandedFindingId
    : findings[0]?.id;

  return (
    <section className="space-y-3" aria-label="Finding activity">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <p className="text-muted-foreground type-body">
          Expand a Security Finding to review its complete in-period timeline.
        </p>
        <p className="text-muted-foreground type-code tabular-nums">
          Showing {findings.length} of {totalFindingCount}
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
        <Accordion
          type="multiple"
          defaultValue={visibleInitialFinding ? [visibleInitialFinding] : []}
        >
          {findings.map(finding => (
            <AccordionItem
              key={finding.id}
              value={finding.id}
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

function FindingSummary({ finding }: { finding: AuditFinding }) {
  const latestEvent = finding.events[finding.events.length - 1];
  const eventLabel = `${finding.events.length} ${finding.events.length === 1 ? 'event' : 'events'}`;

  return (
    <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 lg:grid-cols-[minmax(0,1fr)_9rem_11rem] lg:items-center lg:gap-4">
      <div className="col-span-2 min-w-0 lg:col-span-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex w-20 shrink-0 items-center">
            <SeverityBadge severity={finding.severity} size="sm" />
          </div>
          <div className="min-w-0">
            <div className="type-body break-words font-medium">{finding.title}</div>
          </div>
        </div>
      </div>

      <div className="col-start-1 row-start-2 lg:col-start-2 lg:row-start-1">
        <FindingStateBadge state={finding.state} />
      </div>

      <div className="col-start-2 row-start-2 min-w-0 text-right lg:col-start-3 lg:row-start-1 lg:text-left">
        {latestEvent && (
          <div className="type-label truncate text-foreground">{latestEvent.label}</div>
        )}
        <div className="text-muted-foreground type-label mt-0.5 tabular-nums">
          {latestEvent?.date ?? 'No activity'}
          <span aria-hidden="true"> · </span>
          {eventLabel}
        </div>
      </div>
    </div>
  );
}

function FindingStateBadge({ state }: { state: FindingState }) {
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

const findingStateConfig: Record<FindingState, { label: string; tone: Tone; icon: LucideIcon }> = {
  open: { label: 'Open', tone: 'neutral', icon: CircleDot },
  fixed: { label: 'Fixed', tone: 'success', icon: CheckCircle2 },
  dismissed: { label: 'Dismissed', tone: 'neutral', icon: XCircle },
  superseded: { label: 'Superseded', tone: 'neutral', icon: GitMerge },
  deleted: { label: 'Deleted', tone: 'neutral', icon: Trash2 },
};

function FindingDetails({ finding }: { finding: AuditFinding }) {
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

function AuditEventRow({ event, isLast }: { event: AuditEvent; isLast: boolean }) {
  const Icon = event.icon;

  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-7 last:pb-0 sm:grid-cols-[7.5rem_1.75rem_minmax(0,1fr)]">
      <time
        dateTime={event.occurredAt}
        className="text-muted-foreground type-label col-start-2 row-start-1 mb-2 flex flex-wrap gap-x-1.5 tabular-nums sm:col-start-1 sm:mb-0 sm:block sm:pr-1 sm:text-right"
      >
        <span className="sm:block">{event.date}</span>
        <span className="sm:mt-0.5 sm:block">{event.time}</span>
      </time>

      <div
        className="relative col-start-1 row-span-2 row-start-1 flex justify-center sm:col-start-2"
        aria-hidden="true"
      >
        {!isLast && <span className="bg-border absolute top-7 -bottom-7 w-px" />}
        <span
          className={cn(
            'relative flex size-7 items-center justify-center rounded-full ring-1',
            toneStyles[event.tone].icon
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>

      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-span-2 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="type-body font-medium">{event.label}</h4>
          {event.legacy && (
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
          <span>{event.actor}</span>
          {event.actorReference && <code className="type-code">{event.actorReference}</code>}
        </div>
        {event.details.length > 0 && <EventDetails details={event.details} />}
      </div>
    </li>
  );
}

function EventDetails({ details }: { details: EventDetail[] }) {
  return (
    <dl className="border-border mt-3 grid gap-x-6 gap-y-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-3">
      {details.map(detail => (
        <div key={detail.label} className="min-w-0">
          <dt className="text-muted-foreground type-label">{detail.label}</dt>
          <dd className={cn('type-body mt-1 break-words', detail.mono && 'type-code')}>
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

function FindingMetadata({ finding }: { finding: AuditFinding }) {
  return (
    <aside
      className="border-border min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
      aria-label="Finding record"
    >
      <h3 className="type-body font-medium">Finding record</h3>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        <MetadataItem label="Security Finding ID" value={finding.id} mono />
        {finding.canonicalFindingId && (
          <MetadataItem
            label="Current finding"
            value={finding.canonicalFindingId}
            mono
            tone="neutral"
          />
        )}
        <MetadataItem label="Source">
          <ExternalLinkValue href={finding.sourceHref}>{finding.source}</ExternalLinkValue>
        </MetadataItem>
        <MetadataItem label="Repository">
          <ExternalLinkValue href={`https://github.com/${finding.repository}`}>
            {finding.repository}
          </ExternalLinkValue>
        </MetadataItem>
        <MetadataItem
          label="Package"
          value={`${finding.packageName} (${finding.packageEcosystem})`}
        />
        <MetadataItem label="Manifest" value={finding.manifest} mono />
        <MetadataItem label="First detected" value={finding.firstDetected} mono />
        <MetadataItem label="SLA status">
          <span className={cn('type-label font-medium', toneStyles[finding.sla.tone].text)}>
            {finding.sla.label}
          </span>
        </MetadataItem>
        <MetadataItem label="SLA deadline" value={finding.sla.deadline} mono />
        <MetadataItem label="Advisory">
          <div className="flex flex-wrap gap-1.5">
            {finding.advisories.map(advisory => (
              <Badge key={advisory} variant="outline" className="type-code font-normal">
                {advisory}
              </Badge>
            ))}
            {finding.cvss && (
              <Badge variant="secondary" className="font-normal">
                CVSS {finding.cvss}
              </Badge>
            )}
          </div>
        </MetadataItem>
        <MetadataItem
          label="Patched version"
          value={finding.patchedVersion ?? 'Not recorded'}
          mono
        />
      </dl>
    </aside>
  );
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
  tone?: Tone;
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

function ReportEmptyState({
  hasActiveFilters,
  range,
  onClearFilters,
}: {
  hasActiveFilters: boolean;
  range: DateRangePreset;
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
            : `Kilo has no reportable Security Finding activity from ${range.label}.`}
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

function ReportSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">Loading recorded activity</span>
      <Skeleton className="motion-reduce:animate-none h-16" />
      <Skeleton className="motion-reduce:animate-none h-32" />
      <div className="space-y-2">
        <Skeleton className="motion-reduce:animate-none h-16" />
        <Skeleton className="motion-reduce:animate-none h-16" />
        <Skeleton className="motion-reduce:animate-none h-16" />
      </div>
    </div>
  );
}

function getDateRange(rangeId: string): DateRangePreset {
  return dateRanges.find(range => range.id === rangeId) ?? defaultDateRange;
}

function parseSeverityFilter(value: string): SeverityFilter {
  return severityOptions.find(option => option.value === value)?.value ?? 'all';
}

function parseStateFilter(value: string): StateFilter {
  return stateOptions.find(option => option.value === value)?.value ?? 'all';
}

function filterFindings(
  findings: AuditFinding[],
  filters: ReportFilters,
  range: DateRangePreset
): AuditFinding[] {
  return findings.flatMap(finding => {
    const events = finding.events.filter(event => {
      const eventDate = event.occurredAt.slice(0, 10);
      return eventDate >= range.start && eventDate <= range.end;
    });
    const latestEvent = events.at(-1);
    if (!latestEvent) return [];
    if (filters.severity !== 'all' && latestEvent.recordedSeverity !== filters.severity) return [];
    if (filters.state !== 'all' && latestEvent.recordedState !== filters.state) return [];
    if (filters.repository !== 'all' && finding.repository !== filters.repository) return [];
    return [
      {
        ...finding,
        severity: latestEvent.recordedSeverity,
        state: latestEvent.recordedState,
        events,
      },
    ];
  });
}

function summarizeFindings(findings: AuditFinding[]) {
  return findings.reduce(
    (summary, finding) => {
      summary.events += finding.events.length;
      summary[finding.severity] += 1;
      if (finding.state === 'superseded') summary.superseded += 1;
      return summary;
    },
    { events: 0, superseded: 0, critical: 0, high: 0, medium: 0, low: 0 }
  );
}

export const RecordedActivity: Story = {
  render: () => <AuditReportStory />,
};

export const LegacyAndDeletedEvidence: Story = {
  name: 'Legacy and deleted evidence',
  render: () => (
    <AuditReportStory
      initialFilters={{ ...allFilters, state: 'deleted' }}
      initialExpandedFindingId="sf_01JXTWJZ82V4AC6X7M0NK9Q3PE"
    />
  ),
};

export const Empty: Story = {
  render: () => <AuditReportStory sourceFindings={[]} initialExpandedFindingId={undefined} />,
};

export const Loading: Story = {
  render: () => <AuditReportStory viewState="loading" />,
};

export const CompleteQueryFailure: Story = {
  name: 'Complete query failure',
  render: () => <AuditReportStory viewState="failure" />,
};
