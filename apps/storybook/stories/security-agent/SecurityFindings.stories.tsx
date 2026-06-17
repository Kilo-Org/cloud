'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  GitPullRequest,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { SeverityBadge } from '@/components/security-agent/SeverityBadge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toneStyles, type Tone } from './FindingStoryShell';

const meta: Meta = {
  title: 'Security Agent/Findings',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Task-oriented Security Findings listing with explicit analysis and SLA deadline states. The design preserves current filters and actions while aligning the page with Security Agent proposal surfaces.',
      },
    },
  },
  tags: ['!autodocs'],
};

export default meta;

type Story = StoryObj<typeof meta>;
type Severity = 'critical' | 'high' | 'medium' | 'low';
type FindingStateFilter = 'open' | 'closed';
type FindingRecordState = 'open' | 'fixed' | 'dismissed';
type AnalysisState =
  | 'exploitable'
  | 'not_exploitable'
  | 'needs_review'
  | 'analyzing'
  | 'failed'
  | 'not_analyzed';
type ActionKind =
  | 'analyze'
  | 'remediate'
  | 'review'
  | 'view_pr'
  | 'retry_analysis'
  | 'details'
  | 'none';
type SeverityFilter = 'all' | Severity;
type AnalysisFilter = 'all' | AnalysisState;
type SortOption = 'severity_desc' | 'severity_asc' | 'sla_due_at_asc';
type ViewState = 'ready' | 'loading';

type StatusConfig = {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  spinning?: boolean;
};

type FindingListItem = {
  id: string;
  state: FindingRecordState;
  severity: Severity;
  title: string;
  repository: string;
  packageName: string;
  manifest: string;
  analysis: AnalysisState;
  deadline: {
    label: string;
    date: string;
    tone: Tone;
    order: number;
  };
  action: ActionKind;
};

type FindingFilters = {
  repository: string;
  severity: SeverityFilter;
  analysis: AnalysisFilter;
  sort: SortOption;
};

const defaultFilters: FindingFilters = {
  repository: 'all',
  severity: 'all',
  analysis: 'all',
  sort: 'severity_desc',
};

const PAGE_SIZE = 5;
const skeletonRowKeys = ['skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4', 'skeleton-5'];

const openFindings: FindingListItem[] = [
  {
    id: 'finding-legacy-parser',
    state: 'open',
    severity: 'critical',
    title: 'Memory Corruption in legacy-parser',
    repository: 'Kilo-Org/security-agent-testbed',
    packageName: 'legacy-parser 2.6.4',
    manifest: 'services/importer/package.json',
    analysis: 'not_analyzed',
    deadline: {
      label: '3 days overdue',
      date: 'Due Jun 14, 2026',
      tone: 'destructive',
      order: 1,
    },
    action: 'analyze',
  },
  {
    id: 'finding-lodash',
    state: 'open',
    severity: 'high',
    title: 'Command Injection in lodash',
    repository: 'Kilo-Org/security-agent-testbed',
    packageName: 'lodash 4.17.19',
    manifest: 'package.json',
    analysis: 'exploitable',
    deadline: {
      label: 'Due tomorrow',
      date: 'Due Jun 18, 2026',
      tone: 'warning',
      order: 2,
    },
    action: 'remediate',
  },
  {
    id: 'finding-jsonwebtoken',
    state: 'open',
    severity: 'critical',
    title: 'Signature Validation Bypass in jsonwebtoken',
    repository: 'Kilo-Org/cloud',
    packageName: 'jsonwebtoken 8.5.1',
    manifest: 'apps/api/package.json',
    analysis: 'exploitable',
    deadline: {
      label: 'On track',
      date: 'Due Jun 27, 2026',
      tone: 'neutral',
      order: 6,
    },
    action: 'view_pr',
  },
  {
    id: 'finding-axios',
    state: 'open',
    severity: 'high',
    title: 'Server-Side Request Forgery in axios',
    repository: 'Kilo-Org/cloud',
    packageName: 'axios 1.6.2',
    manifest: 'services/gateway/package.json',
    analysis: 'analyzing',
    deadline: {
      label: 'Due in 3 days',
      date: 'Due Jun 20, 2026',
      tone: 'warning',
      order: 3,
    },
    action: 'none',
  },
  {
    id: 'finding-path-to-regexp',
    state: 'open',
    severity: 'high',
    title: 'Regular Expression Denial of Service in path-to-regexp',
    repository: 'Kilo-Org/kilocode',
    packageName: 'path-to-regexp 6.2.1',
    manifest: 'apps/web/package.json',
    analysis: 'needs_review',
    deadline: {
      label: 'Due in 6 days',
      date: 'Due Jun 23, 2026',
      tone: 'neutral',
      order: 4,
    },
    action: 'review',
  },
  {
    id: 'finding-minimist-open',
    state: 'open',
    severity: 'medium',
    title: 'Prototype Pollution in minimist',
    repository: 'Kilo-Org/kilocode',
    packageName: 'minimist 1.2.5',
    manifest: 'packages/cli/package.json',
    analysis: 'not_exploitable',
    deadline: {
      label: 'On track',
      date: 'Due Jul 2, 2026',
      tone: 'neutral',
      order: 7,
    },
    action: 'none',
  },
  {
    id: 'finding-braces',
    state: 'open',
    severity: 'medium',
    title: 'Uncontrolled Resource Consumption in braces',
    repository: 'Kilo-Org/cloud',
    packageName: 'braces 3.0.2',
    manifest: 'packages/build/package.json',
    analysis: 'failed',
    deadline: {
      label: 'Due in 11 days',
      date: 'Due Jun 28, 2026',
      tone: 'neutral',
      order: 5,
    },
    action: 'retry_analysis',
  },
  {
    id: 'finding-semver',
    state: 'open',
    severity: 'low',
    title: 'Regular Expression Denial of Service in semver',
    repository: 'Kilo-Org/kilocode',
    packageName: 'semver 7.5.1',
    manifest: 'package.json',
    analysis: 'needs_review',
    deadline: {
      label: 'Deadline not set',
      date: 'SLA excludes low severity',
      tone: 'neutral',
      order: 99,
    },
    action: 'review',
  },
];

const closedFindings: FindingListItem[] = [
  {
    id: 'finding-minimist-fixed',
    state: 'fixed',
    severity: 'low',
    title: 'Prototype Pollution in minimist',
    repository: 'Kilo-Org/security-agent-testbed',
    packageName: 'minimist 1.2.5',
    manifest: 'package.json',
    analysis: 'not_exploitable',
    deadline: {
      label: 'Fixed before deadline',
      date: 'Fixed Jun 14, 2026',
      tone: 'success',
      order: 1,
    },
    action: 'details',
  },
  {
    id: 'finding-micromatch-dismissed',
    state: 'dismissed',
    severity: 'medium',
    title: 'Regular Expression Denial of Service in micromatch',
    repository: 'Kilo-Org/kilocode',
    packageName: 'micromatch 4.0.5',
    manifest: 'packages/core/package.json',
    analysis: 'not_exploitable',
    deadline: {
      label: 'Dismissed',
      date: 'Dismissed Jun 13, 2026',
      tone: 'neutral',
      order: 2,
    },
    action: 'details',
  },
  {
    id: 'finding-lodash-fixed',
    state: 'fixed',
    severity: 'high',
    title: 'Command Injection in lodash',
    repository: 'Kilo-Org/cloud',
    packageName: 'lodash 4.17.19',
    manifest: 'services/worker/package.json',
    analysis: 'exploitable',
    deadline: {
      label: 'Fixed before deadline',
      date: 'Fixed Jun 12, 2026',
      tone: 'success',
      order: 3,
    },
    action: 'details',
  },
];

const findings = [...openFindings, ...closedFindings];
const repositories = [
  'all',
  ...[...new Set(findings.map(finding => finding.repository)), 'Kilo-Org/kilocode-landing'].sort(),
];

const severityOptions = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] satisfies Array<{ value: SeverityFilter; label: string }>;

const analysisOptions = [
  { value: 'all', label: 'All outcomes' },
  { value: 'exploitable', label: 'Exploitable' },
  { value: 'not_exploitable', label: 'Not exploitable' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'analyzing', label: 'Analyzing' },
  { value: 'failed', label: 'Analysis failed' },
  { value: 'not_analyzed', label: 'Not analyzed' },
] satisfies Array<{ value: AnalysisFilter; label: string }>;

const sortOptions = [
  { value: 'severity_desc', label: 'Severity, highest first' },
  { value: 'severity_asc', label: 'Severity, lowest first' },
  { value: 'sla_due_at_asc', label: 'SLA deadline, soonest first' },
] satisfies Array<{ value: SortOption; label: string }>;

const analysisConfig: Record<AnalysisState, StatusConfig> = {
  exploitable: { label: 'Exploitable', tone: 'destructive', icon: ShieldAlert },
  not_exploitable: { label: 'Not exploitable', tone: 'success', icon: ShieldCheck },
  needs_review: { label: 'Needs review', tone: 'warning', icon: Eye },
  analyzing: { label: 'Analyzing', tone: 'warning', icon: Loader2, spinning: true },
  failed: { label: 'Analysis failed', tone: 'destructive', icon: XCircle },
  not_analyzed: { label: 'Not analyzed', tone: 'neutral', icon: Brain },
};

const actionConfig: Record<Exclude<ActionKind, 'none'>, { label: string; icon: LucideIcon }> = {
  analyze: { label: 'Analyze', icon: Brain },
  remediate: { label: 'Fix', icon: GitPullRequest },
  review: { label: 'Review', icon: Eye },
  view_pr: { label: 'View PR', icon: ExternalLink },
  retry_analysis: { label: 'Retry', icon: RotateCw },
  details: { label: 'View details', icon: Eye },
};

function getActionConfig(action: ActionKind) {
  if (action === 'none') return null;
  return actionConfig[action];
}

const severityOrder: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function parseSeverityFilter(value: string): SeverityFilter {
  return severityOptions.find(option => option.value === value)?.value ?? 'all';
}

function parseAnalysisFilter(value: string): AnalysisFilter {
  return analysisOptions.find(option => option.value === value)?.value ?? 'all';
}

function parseSortOption(value: string): SortOption {
  return sortOptions.find(option => option.value === value)?.value ?? 'severity_desc';
}

function FindingsStory({
  initialFindingState = 'open',
  initialFilters = defaultFilters,
  initialRunningCount = 2,
  sourceFindings = findings,
  viewState = 'ready',
}: {
  initialFindingState?: FindingStateFilter;
  initialFilters?: FindingFilters;
  initialRunningCount?: number;
  sourceFindings?: FindingListItem[];
  viewState?: ViewState;
}) {
  const [findingState, setFindingState] = useState(initialFindingState);
  const [filters, setFilters] = useState({ ...initialFilters });
  const [page, setPage] = useState(1);
  const [isSyncing, setIsSyncing] = useState(false);

  const openCount = sourceFindings.filter(finding => finding.state === 'open').length;
  const closedCount = sourceFindings.length - openCount;
  const analysisAtCapacity = initialRunningCount >= 3;
  const filteredFindings = useMemo(
    () => filterAndSortFindings(sourceFindings, findingState, filters),
    [filters, findingState, sourceFindings]
  );
  const totalPages = Math.max(1, Math.ceil(filteredFindings.length / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const visibleFindings = filteredFindings.slice(pageStart, pageStart + PAGE_SIZE);
  const hasActiveFilters =
    filters.repository !== 'all' || filters.severity !== 'all' || filters.analysis !== 'all';

  function updateFilters(nextFilters: FindingFilters) {
    setFilters(nextFilters);
    setPage(1);
  }

  function syncFindings() {
    setIsSyncing(true);
    window.setTimeout(() => setIsSyncing(false), 900);
  }

  function clearFilters() {
    updateFilters({ ...defaultFilters, sort: filters.sort });
  }

  return (
    <main className="bg-surface-background text-foreground min-h-screen px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
      <div className="mx-auto max-w-[1140px] space-y-6">
        <FindingsHeader />

        <FindingsControls
          findingState={findingState}
          openCount={openCount}
          closedCount={closedCount}
          filters={filters}
          runningCount={initialRunningCount}
          isSyncing={isSyncing}
          isLoading={viewState === 'loading'}
          onFindingStateChange={state => {
            setFindingState(state);
            setPage(1);
          }}
          onFiltersChange={updateFilters}
          onSync={syncFindings}
        />

        <FindingsList
          findingState={findingState}
          findings={visibleFindings}
          filteredCount={filteredFindings.length}
          hasActiveFilters={hasActiveFilters}
          isLoading={viewState === 'loading'}
          page={page}
          totalPages={totalPages}
          analysisAtCapacity={analysisAtCapacity}
          onClearFilters={clearFilters}
          onPageChange={setPage}
        />
      </div>
    </main>
  );
}

function FindingsHeader() {
  return (
    <header className="flex max-w-3xl flex-col gap-2">
      <div className="text-muted-foreground type-eyebrow">Security Agent findings</div>
      <h1 className="type-title">Security Findings</h1>
      <p className="text-muted-foreground type-body max-w-[70ch]">
        Review advisory severity, repository analysis, and SLA deadlines without conflating their
        states.
      </p>
    </header>
  );
}

function FindingsControls({
  findingState,
  openCount,
  closedCount,
  filters,
  runningCount,
  isSyncing,
  isLoading,
  onFindingStateChange,
  onFiltersChange,
  onSync,
}: {
  findingState: FindingStateFilter;
  openCount: number;
  closedCount: number;
  filters: FindingFilters;
  runningCount: number;
  isSyncing: boolean;
  isLoading: boolean;
  onFindingStateChange: (state: FindingStateFilter) => void;
  onFiltersChange: (filters: FindingFilters) => void;
  onSync: () => void;
}) {
  const analysisAtCapacity = runningCount >= 3;

  return (
    <section
      aria-label="Findings controls"
      className="border-border bg-surface-raised rounded-xl border p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <fieldset className="grid min-w-0 gap-2">
          <legend className="text-muted-foreground type-label">Finding state</legend>
          <div className="border-input bg-input-background flex min-h-control-touch w-full items-center gap-1 rounded-lg border p-1 sm:h-control-default sm:min-h-0 sm:w-fit">
            <FindingStateButton
              value="open"
              activeState={findingState}
              count={openCount}
              icon={AlertCircle}
              disabled={isLoading}
              onChange={onFindingStateChange}
            />
            <FindingStateButton
              value="closed"
              activeState={findingState}
              count={closedCount}
              icon={CheckCircle2}
              disabled={isLoading}
              onChange={onFindingStateChange}
            />
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
          <span
            className={cn(
              'type-label inline-flex min-h-8 w-fit items-center gap-1.5 rounded-full border px-3',
              analysisAtCapacity ? toneStyles.destructive.status : toneStyles.neutral.status
            )}
          >
            <span className="type-code tabular-nums">{runningCount}/3</span>
            analysis capacity
          </span>
          <span className="text-muted-foreground type-label flex min-h-8 items-center gap-1.5 whitespace-nowrap">
            <Clock3 className="size-3.5" aria-hidden="true" />
            Last synced about 2 hours ago
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto"
            disabled={isSyncing || isLoading}
            onClick={onSync}
          >
            <RefreshCw
              className={cn(isSyncing && 'animate-spin motion-reduce:animate-none')}
              aria-hidden="true"
            />
            {isSyncing ? 'Syncing findings...' : 'Sync findings'}
          </Button>
        </div>
      </div>

      <div className="border-border mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_minmax(11rem,1fr)_minmax(13rem,1.2fr)]">
        <ControlField id="findings-repository" label="Repository">
          <Select
            value={filters.repository}
            disabled={isLoading}
            onValueChange={repository => onFiltersChange({ ...filters, repository })}
          >
            <SelectTrigger
              id="findings-repository"
              className="min-h-control-touch w-full sm:h-control-default sm:min-h-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repositories.map(repository => (
                <SelectItem key={repository} value={repository}>
                  {repository === 'all' ? 'All repositories' : repository}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlField>

        <ControlField id="findings-severity" label="Severity">
          <Select
            value={filters.severity}
            disabled={isLoading}
            onValueChange={value =>
              onFiltersChange({ ...filters, severity: parseSeverityFilter(value) })
            }
          >
            <SelectTrigger
              id="findings-severity"
              className="min-h-control-touch w-full sm:h-control-default sm:min-h-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {severityOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlField>

        <ControlField id="findings-analysis" label="Analysis outcome">
          <Select
            value={filters.analysis}
            disabled={isLoading}
            onValueChange={value =>
              onFiltersChange({ ...filters, analysis: parseAnalysisFilter(value) })
            }
          >
            <SelectTrigger
              id="findings-analysis"
              className="min-h-control-touch w-full sm:h-control-default sm:min-h-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {analysisOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlField>

        <ControlField id="findings-sort" label="Sort by">
          <Select
            value={filters.sort}
            disabled={isLoading}
            onValueChange={value => onFiltersChange({ ...filters, sort: parseSortOption(value) })}
          >
            <SelectTrigger
              id="findings-sort"
              className="min-h-control-touch w-full sm:h-control-default sm:min-h-0"
            >
              {filters.sort === 'severity_desc' ? (
                <ArrowDown className="size-3.5" aria-hidden="true" />
              ) : filters.sort === 'severity_asc' ? (
                <ArrowUp className="size-3.5" aria-hidden="true" />
              ) : (
                <Clock3 className="size-3.5" aria-hidden="true" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ControlField>
      </div>
    </section>
  );
}

function ControlField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id} className="text-muted-foreground type-label">
        {label}
      </Label>
      {children}
    </div>
  );
}

function FindingStateButton({
  value,
  activeState,
  count,
  icon: Icon,
  disabled,
  onChange,
}: {
  value: FindingStateFilter;
  activeState: FindingStateFilter;
  count: number;
  icon: LucideIcon;
  disabled: boolean;
  onChange: (state: FindingStateFilter) => void;
}) {
  const isActive = value === activeState;

  return (
    <button
      type="button"
      aria-pressed={isActive}
      disabled={disabled}
      onClick={() => onChange(value)}
      className={cn(
        'focus-visible:ring-ring type-body flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 transition-colors outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 sm:flex-none',
        isActive
          ? 'bg-surface-selected text-foreground'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span>
        <span className="type-code tabular-nums">{count}</span> {value}
      </span>
    </button>
  );
}

function FindingsList({
  findingState,
  findings: visibleFindings,
  filteredCount,
  hasActiveFilters,
  isLoading,
  page,
  totalPages,
  analysisAtCapacity,
  onClearFilters,
  onPageChange,
}: {
  findingState: FindingStateFilter;
  findings: FindingListItem[];
  filteredCount: number;
  hasActiveFilters: boolean;
  isLoading: boolean;
  page: number;
  totalPages: number;
  analysisAtCapacity: boolean;
  onClearFilters: () => void;
  onPageChange: (page: number) => void;
}) {
  const firstVisible = filteredCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(page * PAGE_SIZE, filteredCount);

  return (
    <section
      aria-label={findingState === 'open' ? 'Open findings' : 'Closed findings'}
      className="space-y-3"
    >
      <div className="border-border bg-surface-raised overflow-hidden rounded-xl border">
        <div
          className="border-border bg-surface-inset text-muted-foreground type-label hidden grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] gap-4 lg:gap-x-3 border-b px-5 py-2.5 lg:grid"
          aria-hidden="true"
        >
          <span>Security Finding</span>
          <span>Analysis</span>
          <span>SLA Deadline</span>
          <span className="text-right">Action</span>
          <span />
        </div>

        {isLoading ? (
          <FindingsSkeleton />
        ) : visibleFindings.length > 0 ? (
          <ul className="divide-border divide-y">
            {visibleFindings.map(finding => (
              <FindingRow
                key={finding.id}
                finding={finding}
                analysisAtCapacity={analysisAtCapacity}
              />
            ))}
          </ul>
        ) : (
          <FindingsEmptyState
            findingState={findingState}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={onClearFilters}
          />
        )}
      </div>

      {!isLoading && filteredCount > 0 && (
        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground type-code tabular-nums">
            Showing {firstVisible}-{lastVisible} of {filteredCount}
          </p>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch sm:h-control-default sm:min-h-0"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <span className="text-muted-foreground type-code px-1 tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-control-touch sm:h-control-default sm:min-h-0"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              Next
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function FindingRow({
  finding,
  analysisAtCapacity,
}: {
  finding: FindingListItem;
  analysisAtCapacity: boolean;
}) {
  const analysis = analysisConfig[finding.analysis];
  const action = getActionConfig(finding.action);
  const ActionIcon = action?.icon;
  const deadlineIcon =
    finding.deadline.tone === 'success'
      ? CheckCircle2
      : finding.deadline.tone === 'destructive'
        ? AlertTriangle
        : Clock3;
  const DeadlineIcon = deadlineIcon;
  const actionDisabled = finding.action === 'analyze' && analysisAtCapacity;

  return (
    <li className="hover:bg-surface-hover grid gap-4 px-4 py-4 transition-colors sm:grid-cols-2 sm:px-5 lg:grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] lg:gap-x-3 lg:items-center">
      <div className="min-w-0 sm:col-span-2 lg:col-span-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex w-20 shrink-0 items-center">
            <SeverityBadge severity={finding.severity} size="sm" />
          </div>
          <span className="type-body min-w-0 font-medium">{finding.title}</span>
        </div>
      </div>

      <FindingStatusCell label="Analysis">
        <StatusPill config={analysis} />
      </FindingStatusCell>

      <FindingStatusCell label="SLA Deadline">
        <div
          className={cn(
            'type-label flex items-start gap-2',
            toneStyles[finding.deadline.tone].text
          )}
        >
          <DeadlineIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div>
            <div className="font-medium">{finding.deadline.label}</div>
            <div className="text-muted-foreground mt-0.5 tabular-nums">{finding.deadline.date}</div>
          </div>
        </div>
      </FindingStatusCell>

      <div className="flex items-center justify-end gap-2 sm:col-span-2 lg:col-span-2 lg:grid lg:grid-cols-[minmax(9rem,auto)_2.25rem]">
        {action && ActionIcon && (
          <Button
            type="button"
            variant="outline"
            className="min-h-control-touch w-full sm:h-control-default sm:min-h-0 sm:w-auto lg:justify-self-end"
            disabled={actionDisabled}
            title={
              actionDisabled
                ? 'Analysis capacity is full. Try again when a slot is available.'
                : undefined
            }
          >
            <ActionIcon aria-hidden="true" />
            {action.label}
          </Button>
        )}
        <ChevronRight
          className="text-muted-foreground size-4 shrink-0 lg:col-start-2 lg:justify-self-center"
          aria-hidden="true"
        />
      </div>
    </li>
  );
}

function FindingStatusCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground type-label mb-2 lg:hidden">{label}</div>
      {children}
    </div>
  );
}

function StatusPill({ config }: { config: StatusConfig }) {
  const Icon = config.icon;
  return (
    <span
      className={cn(
        'type-label inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1',
        toneStyles[config.tone].status
      )}
    >
      <Icon
        className={cn('size-3.5', config.spinning && 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
      {config.label}
    </span>
  );
}

function FindingsSkeleton() {
  return (
    <div className="divide-border divide-y" role="status">
      <span className="sr-only">Loading Security Findings</span>
      {skeletonRowKeys.map(rowKey => (
        <div
          key={rowKey}
          className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] lg:gap-x-3 lg:items-center"
        >
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-1">
            <Skeleton className="h-5 w-16 shrink-0" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <Skeleton className="h-7 w-28" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex items-center justify-end gap-2 sm:col-span-2 lg:col-span-2 lg:grid lg:grid-cols-[minmax(9rem,auto)_2.25rem]">
            <Skeleton className="h-9 w-full sm:w-28 lg:justify-self-end" />
            <Skeleton className="size-9 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingsEmptyState({
  findingState,
  hasActiveFilters,
  onClearFilters,
}: {
  findingState: FindingStateFilter;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const Icon = hasActiveFilters ? AlertTriangle : ShieldCheck;

  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center sm:py-16">
      <div className="border-border bg-surface-inset text-muted-foreground flex size-11 items-center justify-center rounded-full border">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <h3 className="type-heading mt-4">
        {hasActiveFilters
          ? 'No findings match these filters'
          : findingState === 'open'
            ? 'No open findings'
            : 'No closed findings'}
      </h3>
      <p className="text-muted-foreground type-body mt-2 max-w-[52ch]">
        {hasActiveFilters
          ? 'Change or clear filters to include more Security Findings.'
          : findingState === 'open'
            ? 'New Security Findings will appear here after the next successful sync.'
            : 'Fixed and dismissed Security Findings will appear here.'}
      </p>
      {hasActiveFilters && (
        <Button type="button" variant="outline" className="mt-5" onClick={onClearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function filterAndSortFindings(
  sourceFindings: FindingListItem[],
  findingState: FindingStateFilter,
  filters: FindingFilters
) {
  const filtered = sourceFindings.filter(finding => {
    const matchesState =
      findingState === 'open' ? finding.state === 'open' : finding.state !== 'open';
    const matchesRepository =
      filters.repository === 'all' || finding.repository === filters.repository;
    const matchesSeverity = filters.severity === 'all' || finding.severity === filters.severity;
    const matchesAnalysis = filters.analysis === 'all' || finding.analysis === filters.analysis;
    return matchesState && matchesRepository && matchesSeverity && matchesAnalysis;
  });

  return filtered.toSorted((left, right) => {
    if (filters.sort === 'sla_due_at_asc') return left.deadline.order - right.deadline.order;
    const difference = severityOrder[left.severity] - severityOrder[right.severity];
    if (difference !== 0) return filters.sort === 'severity_desc' ? difference : -difference;
    return left.title.localeCompare(right.title);
  });
}

export const OpenFindings: Story = {
  name: 'Open findings',
  render: () => <FindingsStory />,
};

export const ClosedFindings: Story = {
  name: 'Closed findings',
  render: () => <FindingsStory initialFindingState="closed" />,
};

export const AnalysisCapacityFull: Story = {
  name: 'Analysis capacity full',
  render: () => <FindingsStory initialRunningCount={3} />,
};

export const Loading: Story = {
  render: () => <FindingsStory viewState="loading" />,
};

export const FilteredEmpty: Story = {
  name: 'Filtered empty',
  render: () => (
    <FindingsStory
      initialFilters={{
        ...defaultFilters,
        repository: 'Kilo-Org/kilocode-landing',
      }}
    />
  ),
};

export const NoOpenFindings: Story = {
  name: 'No open findings',
  render: () => <FindingsStory sourceFindings={closedFindings} />,
};
