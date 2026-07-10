'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import type { SecurityFinding } from '@kilocode/db/schema';
import { formatDistanceToNow, isPast } from 'date-fns';
import {
  Ban,
  Brain,
  Check,
  CheckCircle2,
  CircleHelp,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FileWarning,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Info,
  Loader2,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  UserRound,
  Wrench,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { MarkdownProse } from './MarkdownProse';
import { useSecurityAgent } from './SecurityAgentContext';
import {
  isAwaitingManualAnalysisAdmission,
  manualAnalysisAdmissionCopy,
  manualAnalysisCapacityFullCopy,
} from './manual-analysis-admission-copy';
import {
  getRemediationUnavailableCopy,
  isCodebaseAnalysisRequiredReason,
} from './remediation-unavailable-copy';
import { getFindingAnalysisState, toWebTone } from './security-finding-list-presentation';
import type { SecurityFindingWithRemediation } from '@/lib/security-agent/db/security-remediation';
import {
  getDismissalReasonLabel,
  getFindingLifecycleStatusPresentation,
  getFindingSeverityPresentation,
  getFindingSourceLabel,
  getSupersedingFindingId as getSharedSupersedingFindingId,
} from '@kilocode/app-shared/security-agent';

type FindingAnalysis = SecurityFinding['analysis'];
type FindingTab = 'details' | 'analysis' | 'remediation';
type Tone = 'success' | 'warning' | 'destructive' | 'neutral';
type StartAnalysisOptions = {
  forceSandbox?: boolean;
  retrySandboxOnly?: boolean;
  restartActive?: boolean;
};
type StartAnalysis = (options?: StartAnalysisOptions) => void;
type StartFindingAnalysis = (findingId: string, options?: StartAnalysisOptions) => void;

type RemediationAttempt = {
  id: string;
  status: string;
  origin: string;
  attemptNumber: number;
  requestedByUserId: string | null;
  remediationModelSlug: string;
  branchName: string;
  prUrl: string | null;
  prNumber: number | null;
  prDraft: boolean | null;
  failureCode: string | null;
  blockedReason: string | null;
  lastErrorRedacted: string | null;
  validationEvidence: Record<string, unknown>[] | null;
  riskNotes: string | null;
  draftReason: string | null;
  cancellationRequestedAt: string | null;
  queuedAt: string;
  launchedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

type StatusValue = {
  value: string;
  tone: Tone;
};

type DetailFact = {
  label: string;
  value: string;
  mono?: boolean;
};

type SummaryItem = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: Tone;
};

type ProgressStep = {
  title: string;
  detail: string;
  state: 'done' | 'running' | 'waiting' | 'attention' | 'pending' | 'error';
};

type AnalysisAction =
  | 'none'
  | 'start-analysis'
  | 'retry-analysis'
  | 'start-remediation'
  | 'view-remediation'
  | 'dismiss'
  | 'source'
  | 'cloud-agent';

type AnalysisPresentation = {
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
    spinning?: boolean;
  };
  summary: SummaryItem[];
  context: string;
  action: {
    label: 'Next step' | 'Current status';
    title: string;
    description: string;
    buttonLabel?: string;
    buttonIcon?: LucideIcon;
    kind: AnalysisAction;
    primary?: boolean;
  };
  disclosureTitle: string;
};

type RemediationPresentation = {
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
    spinning?: boolean;
  };
  summary: SummaryItem[];
  context: string;
  action: {
    label: 'Next step' | 'Attempt controls' | 'Current status';
    title: string;
    description: string;
  };
  disclosureTitle: string;
  steps: ProgressStep[];
};

const ANALYSIS_POLL_INTERVAL_MS = 3000;
const utcDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const utcTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const toneStyles: Record<
  Tone,
  { status: string; icon: string; text: string; step: string; border: string }
> = {
  success: {
    status: 'border-status-success-border bg-status-success-surface text-status-success',
    icon: 'bg-status-success-surface text-status-success-icon ring-status-success-border',
    text: 'text-status-success',
    step: 'bg-status-success-surface text-status-success ring-status-success-border',
    border: 'border-status-success-border bg-status-success-surface',
  },
  warning: {
    status: 'border-status-warning-border bg-status-warning-surface text-status-warning',
    icon: 'bg-status-warning-surface text-status-warning-icon ring-status-warning-border',
    text: 'text-status-warning',
    step: 'bg-status-warning-surface text-status-warning ring-status-warning-border',
    border: 'border-status-warning-border bg-status-warning-surface',
  },
  destructive: {
    status:
      'border-status-destructive-border bg-status-destructive-surface text-status-destructive',
    icon: 'bg-status-destructive-surface text-status-destructive-icon ring-status-destructive-border',
    text: 'text-status-destructive',
    step: 'bg-status-destructive-surface text-status-destructive ring-status-destructive-border',
    border: 'border-status-destructive-border bg-status-destructive-surface',
  },
  neutral: {
    status: 'border-status-neutral-border bg-status-neutral-surface text-status-neutral',
    icon: 'bg-status-neutral-surface text-status-neutral-icon ring-status-neutral-border',
    text: 'text-status-neutral',
    step: 'bg-status-neutral-surface text-status-neutral-icon ring-status-neutral-border',
    border: 'border-status-neutral-border bg-surface-inset',
  },
};

function LoadingSpinner({ className = 'size-4' }: { className?: string }) {
  return (
    <Loader2
      className={cn(className, 'animate-spin motion-reduce:animate-none')}
      aria-hidden="true"
    />
  );
}

function formatUtcDate(value: string, includeTime = true): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const dateText = utcDateFormatter.format(date);
  if (!includeTime) return dateText;
  return `${dateText} at ${utcTimeFormatter.format(date)} UTC`;
}

function formatSource(source: string): string {
  return getFindingSourceLabel(source);
}

function getSupersedingFindingId(finding: SecurityFinding): string | null {
  return getSharedSupersedingFindingId(finding);
}

function getDismissalReason(reason: string | null): string {
  return getDismissalReasonLabel(reason);
}

function formatRemediationStatus(
  status: string | null | undefined,
  cancellationRequestedAt?: string | null
): string {
  if (cancellationRequestedAt && isActiveRemediationStatus(status)) return 'Cancellation requested';
  if (!status) return 'Not started';
  if (status === 'pr_opened') return 'PR opened';
  if (status === 'no_changes_needed') return 'No changes needed';
  if (status === 'launching') return 'Starting';
  return status.replace(/_/g, ' ');
}

function formatRemediationOrigin(origin: string): string {
  if (origin === 'auto_policy') return 'Automatic policy';
  if (origin === 'bulk_existing') return 'Include existing policy';
  if (origin === 'manual') return 'Manual';
  return origin.replace(/_/g, ' ');
}

function isActiveRemediationStatus(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'launching' || status === 'running';
}

function getSeverityStatus(severity: string): StatusValue {
  const presentation = getFindingSeverityPresentation(severity);
  return { value: presentation.label, tone: toWebTone(presentation.tone) };
}

function getFindingStatus(finding: SecurityFinding): StatusValue {
  const presentation = getFindingLifecycleStatusPresentation(finding);
  return { value: presentation.label, tone: toWebTone(presentation.tone) };
}

function getAnalysisStatus(analysis: FindingAnalysis, analysisStatus: string | null): StatusValue {
  switch (getFindingAnalysisState(analysisStatus, analysis)) {
    case 'queued':
      return { value: 'Analysis queued', tone: 'warning' };
    case 'analyzing':
      return { value: 'Analyzing', tone: 'warning' };
    case 'failed':
      return { value: 'Analysis failed', tone: 'destructive' };
    case 'extraction-failed':
    case 'unknown':
    case 'manual-review':
      return { value: 'Needs review', tone: 'warning' };
    case 'exploitable':
      return { value: 'Exploitable', tone: 'destructive' };
    case 'not-exploitable':
      return { value: 'Unreachable', tone: 'success' };
    case 'safe-to-dismiss':
      return { value: 'Safe to dismiss', tone: 'success' };
    case 'analysis-required':
      return { value: 'Analysis required', tone: 'warning' };
    case 'completed':
      return { value: 'Analyzed', tone: 'neutral' };
    case 'not-analyzed':
      return { value: 'Not analyzed', tone: 'neutral' };
  }
}

function LabeledStatus({ label, value, tone }: StatusValue & { label: string }) {
  return (
    <div
      className={cn('type-label flex items-center rounded-full border', toneStyles[tone].status)}
    >
      <span className="border-status-neutral-border text-muted-foreground px-status border-r py-1">
        {label}
      </span>
      <span className="px-status py-1">{value}</span>
    </div>
  );
}

function FindingOutcome({
  title,
  description,
  icon: Icon,
  tone,
  spinning = false,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: Tone;
  spinning?: boolean;
}) {
  return (
    <section className="flex gap-3 sm:gap-4" role="status" aria-live="polite" aria-atomic="true">
      <div
        className={cn(
          'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full ring-1',
          toneStyles[tone].icon
        )}
      >
        <Icon
          className={cn('size-5', spinning && 'animate-spin motion-reduce:animate-none')}
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0">
        <h3 className="type-heading">{title}</h3>
        <p className="text-muted-foreground type-body mt-1 max-w-[68ch]">{description}</p>
      </div>
    </section>
  );
}

function FindingActionSection({
  label,
  title,
  description,
  statusMessage,
  children,
}: {
  label: string;
  title: string;
  description: string;
  statusMessage?: string;
  children?: ReactNode;
}) {
  return (
    <section className="border-border grid gap-4 border-t pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div>
        <div className="text-muted-foreground type-label">{label}</div>
        <h4 className="type-body mt-1.5 font-medium">{title}</h4>
        <p className="text-muted-foreground type-body mt-1 max-w-[62ch]">{description}</p>
        {statusMessage && (
          <p className="text-status-warning type-label mt-2" role="status">
            {statusMessage}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap gap-2 sm:justify-end">{children}</div>}
    </section>
  );
}

function FindingContextNote({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground type-label flex max-w-[70ch] items-start gap-2">
      <Info className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

function SummaryGrid({ title, items }: { title: string; items: SummaryItem[] }) {
  return (
    <section>
      <h4 className="type-body mb-3 font-medium">{title}</h4>
      <div className="border-border grid overflow-hidden rounded-lg border md:grid-cols-3">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={cn(
                'min-w-0 p-4',
                index < items.length - 1 && 'border-border border-b md:border-r md:border-b-0'
              )}
            >
              <div className="text-muted-foreground type-label flex items-center gap-2">
                <Icon
                  className={cn('size-icon-sm', toneStyles[item.tone].text)}
                  aria-hidden="true"
                />
                {item.label}
              </div>
              <div className={cn('type-body mt-2 font-medium', toneStyles[item.tone].text)}>
                {item.value}
              </div>
              <div className="text-muted-foreground type-label mt-1">{item.detail}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProgressStepRow({ step, index }: { step: ProgressStep; index: number }) {
  const presentation = {
    done: { icon: Check, classes: toneStyles.success.step },
    running: { icon: Loader2, classes: toneStyles.warning.step },
    waiting: { icon: Clock3, classes: toneStyles.warning.step },
    attention: { icon: TriangleAlert, classes: toneStyles.warning.step },
    pending: { icon: null, classes: toneStyles.neutral.step },
    error: { icon: XCircle, classes: toneStyles.destructive.step },
  }[step.state];
  const StepIcon = presentation.icon;

  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
      <div
        className={cn(
          'size-control-default type-code flex items-center justify-center rounded-md ring-1',
          presentation.classes
        )}
      >
        {StepIcon ? (
          <StepIcon
            className={cn(
              'size-4',
              step.state === 'running' && 'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden="true"
          />
        ) : (
          String(index + 1).padStart(2, '0')
        )}
      </div>
      <div className="pt-0.5">
        <h5 className="type-body font-medium">{step.title}</h5>
        <p className="text-muted-foreground type-body mt-0.5">{step.detail}</p>
      </div>
    </li>
  );
}

function DetailFactCell({ fact }: { fact: DetailFact }) {
  return (
    <div className="bg-surface-raised min-w-0 p-4">
      <dt className="text-muted-foreground type-label">{fact.label}</dt>
      <dd className={cn('type-body mt-1 break-words', fact.mono ? 'type-code' : 'font-medium')}>
        {fact.value}
      </dd>
    </div>
  );
}

function DetailFactItem({ fact }: { fact: DetailFact }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground type-label">{fact.label}</dt>
      <dd className={cn('type-body mt-1 break-words', fact.mono ? 'type-code' : 'font-medium')}>
        {fact.value}
      </dd>
    </div>
  );
}

type FindingDetailsAction = {
  title: string;
  description: string;
  label: string;
  kind: 'analyze' | 'remediation' | 'source' | 'current' | 'none';
};

type FindingDetailsPresentation = {
  supersedingFindingId: string | null;
  isOverdue: boolean;
  hero: {
    title: string;
    description: string;
    icon: LucideIcon;
    tone: Tone;
  };
  action: FindingDetailsAction;
  facts: DetailFact[];
  sourceFacts: DetailFact[];
  contextNote: string;
};

function getFindingDetailsPresentation(
  finding: SecurityFinding,
  analysis: FindingAnalysis,
  showSla: boolean
): FindingDetailsPresentation {
  const supersedingFindingId = getSupersedingFindingId(finding);
  const isOverdue =
    showSla &&
    finding.status === 'open' &&
    Boolean(finding.sla_due_at) &&
    isPast(new Date(finding.sla_due_at ?? ''));
  const sandbox = analysis?.sandboxAnalysis;

  let hero = {
    title: 'This finding is open',
    description:
      'GitHub continues to report the vulnerable package in this repository. Review project-specific analysis before choosing a response.',
    icon: ShieldAlert,
    tone: 'warning' as Tone,
  };
  if (supersedingFindingId) {
    hero = {
      title: 'Replaced by a current finding',
      description:
        'Security Agent linked this duplicate to the current finding. Use that record for status, analysis, and remediation.',
      icon: GitMerge,
      tone: 'neutral',
    };
  } else if (finding.status === 'fixed') {
    hero = {
      title: 'The source reports this finding fixed',
      description:
        'GitHub no longer reports the vulnerable package version in this repository. No further Security Agent action is required.',
      icon: ShieldCheck,
      tone: 'success',
    };
  } else if (finding.status === 'ignored') {
    hero = {
      title: 'Dismissed after review',
      description: `This finding was dismissed because ${getDismissalReason(finding.ignored_reason)}. The vulnerable dependency has not been presented as fixed.`,
      icon: XCircle,
      tone: 'neutral',
    };
  } else if (isOverdue) {
    hero = {
      title: 'Resolution deadline has passed',
      description:
        'This finding is still open. Review current repository evidence and prioritize the appropriate response.',
      icon: Clock3,
      tone: 'destructive',
    };
  } else if (sandbox?.isExploitable === true) {
    hero = {
      title: 'This finding is open',
      description:
        'The vulnerable package remains in the repository. Security Agent found that application code can reach the affected feature.',
      icon: ShieldAlert,
      tone: 'destructive',
    };
  }

  let action: FindingDetailsAction = {
    title: 'Determine project risk',
    description:
      'Analyze the repository to check whether application code can reach the affected feature and identify safe fix options.',
    label: 'Analyze repository',
    kind: 'analyze',
  };
  if (supersedingFindingId) {
    action = {
      title: 'Continue with the current record',
      description:
        'Open the current finding to review its latest status and Security Agent activity.',
      label: 'Open current finding',
      kind: 'current',
    };
  } else if (finding.status === 'fixed' || finding.status === 'ignored') {
    action = {
      title: 'No immediate response needed',
      description: 'Keep this record for history or review the original source advisory.',
      label: 'View source record',
      kind: finding.dependabot_html_url ? 'source' : 'none',
    };
  } else if (sandbox) {
    action = {
      title: 'Review remediation options',
      description:
        sandbox.isExploitable === false
          ? 'No reachable path was found. Review routine update options and the supporting evidence.'
          : 'Review the current capability, fix path, and any existing remediation attempts.',
      label: 'View remediation',
      kind: 'remediation',
    };
  }

  const facts: DetailFact[] = [
    ...(finding.cve_id ? [{ label: 'CVE', value: finding.cve_id, mono: true }] : []),
    ...(finding.ghsa_id ? [{ label: 'GHSA', value: finding.ghsa_id, mono: true }] : []),
    {
      label: 'Vulnerable versions',
      value: finding.vulnerable_version_range || 'Unknown',
      mono: Boolean(finding.vulnerable_version_range),
    },
    {
      label: 'Patched version',
      value: finding.patched_version || 'No patch available',
      mono: Boolean(finding.patched_version),
    },
    ...(finding.manifest_path
      ? [{ label: 'Manifest', value: finding.manifest_path, mono: true }]
      : []),
  ];
  const sourceFacts: DetailFact[] = [
    { label: 'Source', value: formatSource(finding.source) },
    { label: 'Source ID', value: finding.source_id, mono: true },
    { label: 'First detected', value: formatUtcDate(finding.first_detected_at), mono: true },
    { label: 'Last synced', value: formatUtcDate(finding.last_synced_at), mono: true },
    ...(finding.fixed_at
      ? [{ label: 'Fixed', value: formatUtcDate(finding.fixed_at), mono: true }]
      : []),
    ...(supersedingFindingId
      ? [{ label: 'Current finding', value: supersedingFindingId, mono: true }]
      : []),
  ];
  const contextNote = supersedingFindingId
    ? 'Superseded findings remain separate historical records. Analysis and remediation details stay with the current finding.'
    : finding.status === 'fixed'
      ? 'Fixed is a source status. A pull request opened by Security Agent would not have changed the finding to fixed by itself.'
      : finding.status === 'ignored'
        ? 'Dismissed records a disposition, not a package update. Future source changes can cause Security Agent to reassess the finding.'
        : 'This finding closes only after GitHub reports the vulnerability fixed or someone dismisses it.';

  return { supersedingFindingId, isOverdue, hero, action, facts, sourceFacts, contextNote };
}

function FindingTimeline({
  finding,
  showSla,
  isOverdue,
  supersedingFindingId,
}: {
  finding: SecurityFinding;
  showSla: boolean;
  isOverdue: boolean;
  supersedingFindingId: string | null;
}) {
  if (showSla && finding.status === 'open' && finding.sla_due_at) {
    const tone = isOverdue ? 'destructive' : 'warning';
    return (
      <section
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
          toneStyles[tone].border
        )}
      >
        <div className={cn('type-body flex items-center gap-2 font-medium', toneStyles[tone].text)}>
          <Clock3 className="size-4 shrink-0" aria-hidden="true" />
          {isOverdue
            ? `Resolution deadline passed ${formatDistanceToNow(new Date(finding.sla_due_at))} ago`
            : `Resolution deadline in ${formatDistanceToNow(new Date(finding.sla_due_at))}`}
        </div>
        <span className="text-muted-foreground type-code tabular-nums">
          {formatUtcDate(finding.sla_due_at)}
        </span>
      </section>
    );
  }

  if (finding.status === 'fixed' && finding.fixed_at) {
    return (
      <section
        className={cn(
          'flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
          toneStyles.success.border
        )}
      >
        <div className="text-status-success type-body flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          Fixed {formatDistanceToNow(new Date(finding.fixed_at), { addSuffix: true })}
        </div>
        <span className="text-muted-foreground type-code tabular-nums">
          {formatUtcDate(finding.fixed_at)}
        </span>
      </section>
    );
  }

  if (finding.status !== 'ignored') return null;
  return (
    <section
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
        toneStyles.neutral.border
      )}
    >
      <div className="type-body flex items-center gap-2 font-medium">
        {supersedingFindingId ? (
          <GitMerge className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <XCircle className="size-4 shrink-0" aria-hidden="true" />
        )}
        {supersedingFindingId
          ? 'Superseded during synchronization'
          : `Dismissed: ${getDismissalReason(finding.ignored_reason)}`}
      </div>
      <span className="text-muted-foreground type-code tabular-nums">
        {formatUtcDate(finding.updated_at)}
      </span>
    </section>
  );
}

function FindingDetailActions({
  finding,
  action,
  supersedingFindingId,
  canDismiss,
  analysisActionDisabled,
  analysisActionTitle,
  onDismiss,
  onOpenFinding,
  onSelectTab,
  onStartCodebaseAnalysis,
}: Omit<FindingDetailsProps, 'analysis' | 'showSla'> & {
  action: FindingDetailsAction;
  supersedingFindingId: string | null;
}) {
  return (
    <FindingActionSection
      label="Next step"
      title={action.title}
      description={action.description}
      statusMessage={action.kind === 'analyze' ? analysisActionTitle : undefined}
    >
      {action.kind === 'analyze' && (
        <Button
          className="h-control-touch"
          onClick={onStartCodebaseAnalysis}
          disabled={analysisActionDisabled}
          title={analysisActionTitle}
        >
          <Brain aria-hidden="true" />
          {action.label}
        </Button>
      )}
      {action.kind === 'remediation' && (
        <Button
          variant="outline"
          className="h-control-touch"
          onClick={() => onSelectTab('remediation')}
        >
          <GitPullRequest aria-hidden="true" />
          {action.label}
        </Button>
      )}
      {action.kind === 'source' && finding.dependabot_html_url && (
        <Button variant="outline" className="h-control-touch" asChild>
          <a href={finding.dependabot_html_url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            {action.label}
          </a>
        </Button>
      )}
      {action.kind === 'current' && supersedingFindingId && (
        <Button className="h-control-touch" onClick={() => onOpenFinding(supersedingFindingId)}>
          <GitMerge aria-hidden="true" />
          {action.label}
        </Button>
      )}
      {canDismiss && finding.status === 'open' && (
        <Button variant="outline" className="h-control-touch" onClick={onDismiss}>
          <XCircle aria-hidden="true" />
          Dismiss finding
        </Button>
      )}
    </FindingActionSection>
  );
}

type FindingDetailsProps = {
  finding: SecurityFinding;
  analysis: FindingAnalysis;
  showSla: boolean;
  canDismiss: boolean;
  analysisActionDisabled: boolean;
  analysisActionTitle?: string;
  onDismiss: () => void;
  onOpenFinding: (findingId: string) => void;
  onSelectTab: (tab: FindingTab) => void;
  onStartCodebaseAnalysis: () => void;
};

function FindingDetails({
  finding,
  analysis,
  showSla,
  canDismiss,
  analysisActionDisabled,
  analysisActionTitle,
  onDismiss,
  onOpenFinding,
  onSelectTab,
  onStartCodebaseAnalysis,
}: FindingDetailsProps) {
  const { supersedingFindingId, isOverdue, hero, action, facts, sourceFacts, contextNote } =
    getFindingDetailsPresentation(finding, analysis, showSla);

  return (
    <TabsContent value="details" className="m-0 focus-visible:ring-inset">
      <div className="space-y-6">
        <FindingOutcome {...hero} />

        <FindingTimeline
          finding={finding}
          showSla={showSla}
          isOverdue={isOverdue}
          supersedingFindingId={supersedingFindingId}
        />

        <FindingDetailActions
          finding={finding}
          action={action}
          supersedingFindingId={supersedingFindingId}
          canDismiss={canDismiss}
          analysisActionDisabled={analysisActionDisabled}
          analysisActionTitle={analysisActionTitle}
          onDismiss={onDismiss}
          onOpenFinding={onOpenFinding}
          onSelectTab={onSelectTab}
          onStartCodebaseAnalysis={onStartCodebaseAnalysis}
        />

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Package className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
              <h4 className="type-body min-w-0 break-words font-medium">
                {finding.package_name} {finding.vulnerable_version_range || ''} (
                {finding.package_ecosystem})
              </h4>
            </div>
            <span className="text-muted-foreground type-label">Package advisory</span>
          </div>
          <dl className="border-border bg-border gap-hairline grid overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
            {facts.map(fact => (
              <DetailFactCell key={fact.label} fact={fact} />
            ))}
          </dl>
          {finding.dependabot_html_url && (
            <a
              href={finding.dependabot_html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:text-link-hover focus-visible:ring-ring type-label mt-3 inline-flex items-center gap-1 rounded-sm underline decoration-current/40 underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
            >
              View on GitHub
              <ExternalLink className="size-icon-sm" aria-hidden="true" />
            </a>
          )}
        </section>

        <section className="max-w-[70ch] space-y-3">
          <div>
            <h4 className="type-body font-medium">About this vulnerability</h4>
            {finding.description ? (
              <MarkdownProse
                markdown={finding.description}
                className="text-muted-foreground mt-2"
              />
            ) : (
              <p className="text-muted-foreground type-body mt-2">
                No description is available from the source advisory.
              </p>
            )}
          </div>
          <FindingContextNote>{contextNote}</FindingContextNote>
        </section>

        <Accordion type="single" collapsible>
          <AccordionItem value="source" className="border-border border-t">
            <AccordionTrigger className="min-h-control-touch py-3 no-underline hover:no-underline">
              Source record and timestamps
            </AccordionTrigger>
            <AccordionContent className="pb-5">
              <div className="space-y-4">
                <dl className="type-body grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                  {sourceFacts.map(fact => (
                    <DetailFactItem key={fact.label} fact={fact} />
                  ))}
                </dl>
                <div className="text-muted-foreground type-label flex max-w-[68ch] items-start gap-2">
                  <FileCode2 className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
                  <p>
                    Security Agent preserves source identity and synchronization timestamps for
                    traceability.
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </TabsContent>
  );
}

type AnalysisInteractionState = {
  isAwaitingAnalysisAdmission: boolean;
  isAnalyzing: boolean;
  isRestartingAnalysis: boolean;
  analysisActionDisabled: boolean;
  analysisActionTitle?: string;
  canDismiss: boolean;
  canStartRemediation: boolean;
  isAwaitingRemediationStart: boolean;
};

type FindingAnalysisProps = {
  finding: SecurityFinding;
  analysis: FindingAnalysis;
  analysisStatus: string | null;
  analysisError: string | null;
  cliSessionId: string | null;
  organizationId?: string;
  interactionState: AnalysisInteractionState;
  onStartAnalysis: StartAnalysis;
  onRestartAnalysis: () => void;
  onStartCodebaseAnalysis: () => void;
  onStartRemediation: () => void;
  onDismiss: () => void;
  onSelectTab: (tab: FindingTab) => void;
};

function getAnalysisPresentation({
  finding,
  analysis,
  analysisStatus,
  analysisError,
  isAwaitingAnalysisAdmission,
  canStartRemediation,
}: {
  finding: SecurityFinding;
  analysis: FindingAnalysis;
  analysisStatus: string | null;
  analysisError: string | null;
  isAwaitingAnalysisAdmission: boolean;
  canStartRemediation: boolean;
}): AnalysisPresentation {
  const sandbox = analysis?.sandboxAnalysis;
  const triage = analysis?.triage;

  if (isAwaitingAnalysisAdmission || analysisStatus === 'pending' || analysisStatus === 'running') {
    const queued = isAwaitingAnalysisAdmission || analysisStatus === 'pending';
    return {
      hero: {
        title: queued ? 'Analysis is queued' : 'Security Agent is analyzing the repository',
        description: queued
          ? 'Security Agent accepted the request and will begin when analysis capacity is available.'
          : 'The agent is searching for affected feature usage and tracing whether application inputs can reach it.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: queued ? 'Waiting for capacity' : 'Repository analysis',
          detail: queued
            ? 'No repository work has started'
            : 'Source and dependency paths are being checked',
          icon: Clock3,
          tone: 'warning',
        },
        {
          label: 'What is known?',
          value: 'Published vulnerability',
          detail: `${finding.package_name} matches the affected range`,
          icon: ShieldAlert,
          tone: 'warning',
        },
        {
          label: 'Next update',
          value: 'Project risk result',
          detail: 'Status refreshes automatically',
          icon: Sparkles,
          tone: 'neutral',
        },
      ],
      context:
        'Published severity is unchanged while analysis runs. Repository risk remains unknown until analysis completes.',
      action: {
        label: 'Current status',
        title: queued ? 'Waiting for analysis capacity' : 'Checking the repository',
        description: queued
          ? 'This usually takes 1–2 minutes. You can close this dialog and return later.'
          : 'This usually takes 1–2 minutes. If progress stops, restart analysis to queue a new run.',
        kind: 'cloud-agent',
        buttonLabel: 'Watch in Cloud Agent',
        buttonIcon: ExternalLink,
      },
      disclosureTitle: 'Analysis progress',
    };
  }

  if (analysisStatus === 'failed') {
    return {
      hero: {
        title: 'Analysis did not complete',
        description:
          'Security Agent could not finish checking this repository, so no project-specific risk conclusion is available.',
        icon: TriangleAlert,
        tone: 'destructive',
      },
      summary: [
        {
          label: 'What is the result?',
          value: 'Project risk is unknown',
          detail: 'No repository risk conclusion was produced',
          icon: CircleHelp,
          tone: 'warning',
        },
        {
          label: 'Why?',
          value: analysisError || 'Analysis failed',
          detail: 'Review repository access if another attempt fails',
          icon: TriangleAlert,
          tone: 'destructive',
        },
        {
          label: 'What should I do?',
          value: 'Try analysis again',
          detail: 'Retry when repository access is available',
          icon: RefreshCw,
          tone: 'neutral',
        },
      ],
      context:
        'Published severity is unchanged. Repository risk remains unknown until analysis completes.',
      action: {
        label: 'Next step',
        title: 'Run analysis again',
        description:
          'Retry the analysis. If it fails again, verify repository access before requesting manual review.',
        buttonLabel: 'Retry analysis',
        buttonIcon: RefreshCw,
        kind: 'retry-analysis',
        primary: true,
      },
      disclosureTitle: 'Error details',
    };
  }

  if (sandbox?.extractionStatus === 'failed') {
    return {
      hero: {
        title: 'Analysis result needs review',
        description:
          'Security Agent analyzed the repository, but could not turn the technical report into a reliable plain-language result.',
        icon: FileWarning,
        tone: 'warning',
      },
      summary: [
        {
          label: 'What is the result?',
          value: 'No conclusion is available',
          detail: 'Project risk remains unknown',
          icon: CircleHelp,
          tone: 'warning',
        },
        {
          label: 'Did analysis run?',
          value: 'Yes, a report was created',
          detail: 'Only structured summary extraction failed',
          icon: Check,
          tone: 'neutral',
        },
        {
          label: 'What should I do?',
          value: 'Review the technical report',
          detail: 'Use manual review before changing status',
          icon: Search,
          tone: 'neutral',
        },
      ],
      context:
        'Analysis completed and the technical report is available, but the result still needs human review.',
      action: {
        label: 'Next step',
        title: 'Review the generated report',
        description:
          'Read the technical evidence or ask Cloud Agent to explain it. Keep the finding open until the result is clear.',
        buttonLabel: 'Inspect analysis',
        buttonIcon: CircleHelp,
        kind: 'cloud-agent',
      },
      disclosureTitle: 'What happened during analysis',
    };
  }

  if (sandbox?.isExploitable === true) {
    return {
      hero: {
        title: 'Action required',
        description:
          'Analysis found a reachable use of the vulnerable feature in this repository. Prioritize remediation.',
        icon: ShieldAlert,
        tone: 'destructive',
      },
      summary: [
        {
          label: 'Why?',
          value: 'Vulnerable code is reachable',
          detail: sandbox.summary || sandbox.exploitabilityReasoning,
          icon: Search,
          tone: 'destructive',
        },
        {
          label: 'Do I need to act now?',
          value: 'Yes, prioritize this finding',
          detail: `A reachable ${finding.severity}-severity path was found`,
          icon: Clock3,
          tone: 'destructive',
        },
        {
          label: 'What should I do?',
          value: 'Patch and review usage',
          detail: sandbox.suggestedFix || 'Review the flagged code path',
          icon: Wrench,
          tone: 'neutral',
        },
      ],
      context: `Published severity is ${finding.severity}, and application code can reach the affected feature.`,
      action: {
        label: 'Next step',
        title: 'Remediate this finding',
        description:
          sandbox.suggestedFix ||
          'Review the affected call and prepare the smallest safe repository change.',
        buttonLabel: canStartRemediation ? 'Start remediation' : 'View remediation',
        buttonIcon: GitPullRequest,
        kind: canStartRemediation ? 'start-remediation' : 'view-remediation',
        primary: true,
      },
      disclosureTitle: 'How Security Agent reached this decision',
    };
  }

  if (sandbox?.isExploitable === false) {
    return {
      hero: {
        title: 'No reachable risk found',
        description:
          'Analysis found no path that can trigger this vulnerability in this repository. You can update the dependency during routine maintenance.',
        icon: ShieldCheck,
        tone: 'success',
      },
      summary: [
        {
          label: 'Why?',
          value: 'The affected feature is not reachable',
          detail: sandbox.summary || sandbox.exploitabilityReasoning,
          icon: Search,
          tone: 'neutral',
        },
        {
          label: 'Do I need to act now?',
          value: 'No urgent response needed',
          detail: 'Update during routine maintenance',
          icon: Clock3,
          tone: 'success',
        },
        {
          label: 'What should I do?',
          value: finding.patched_version
            ? `Update to ${finding.patched_version}`
            : 'Review update options',
          detail: sandbox.suggestedFix || 'Keep the dependency current',
          icon: Wrench,
          tone: 'neutral',
        },
      ],
      context:
        'This result reflects the repository when it was analyzed. It does not mean the package is fixed.',
      action: {
        label: 'Next step',
        title: 'Update during routine maintenance',
        description: canStartRemediation
          ? 'A patched version or suggested fix is available for a user-reviewed manual remediation.'
          : sandbox.suggestedFix ||
            'Review the source advisory and update the dependency during routine maintenance.',
        buttonLabel: canStartRemediation ? 'View remediation' : 'View source record',
        buttonIcon: canStartRemediation ? GitPullRequest : ExternalLink,
        kind: canStartRemediation ? 'view-remediation' : 'source',
      },
      disclosureTitle: 'How Security Agent reached this decision',
    };
  }

  if (sandbox?.isExploitable === 'unknown') {
    return {
      hero: {
        title: 'Review recommended',
        description:
          'Analysis found relevant repository evidence, but could not confirm whether untrusted input can reach the vulnerable feature.',
        icon: CircleHelp,
        tone: 'warning',
      },
      summary: [
        {
          label: 'Why?',
          value: 'The available evidence is inconclusive',
          detail: sandbox.summary || sandbox.exploitabilityReasoning,
          icon: Search,
          tone: 'warning',
        },
        {
          label: 'Do I need to act now?',
          value: 'Review before dismissing',
          detail: 'The finding is neither confirmed nor cleared',
          icon: Clock3,
          tone: 'warning',
        },
        {
          label: 'What should I do?',
          value: 'Inspect the flagged code',
          detail: sandbox.suggestedFix || 'Confirm whether untrusted input can reach it',
          icon: Wrench,
          tone: 'neutral',
        },
      ],
      context:
        'Analysis could not confirm whether the repository is exposed. Review the evidence before changing finding status.',
      action: {
        label: 'Next step',
        title: canStartRemediation ? 'Review remediation options' : 'Review the flagged code',
        description: canStartRemediation
          ? 'A concrete fix path is available for a user-reviewed manual remediation.'
          : 'Inspect the recorded usage locations and ask Cloud Agent for more context.',
        buttonLabel: canStartRemediation ? 'View remediation' : 'Inspect analysis',
        buttonIcon: canStartRemediation ? GitPullRequest : CircleHelp,
        kind: canStartRemediation ? 'view-remediation' : 'cloud-agent',
        primary: true,
      },
      disclosureTitle: 'Why the result is inconclusive',
    };
  }

  if (triage?.suggestedAction === 'dismiss') {
    return {
      hero: {
        title: 'Initial review found no codebase analysis need',
        description:
          triage.needsSandboxReasoning ||
          'Triage found enough advisory evidence to recommend dismissal without repository analysis.',
        icon: ShieldCheck,
        tone: 'success',
      },
      summary: [
        {
          label: 'What is known?',
          value: 'Triage complete',
          detail: `${triage.confidence} confidence`,
          icon: Check,
          tone: 'success',
        },
        {
          label: 'Repository analysis',
          value: 'Not required by triage',
          detail: 'No codebase-level verdict was generated',
          icon: Brain,
          tone: 'neutral',
        },
        {
          label: 'What should I do?',
          value: 'Review the dismissal',
          detail: 'Confirm the advisory context before dismissing',
          icon: Search,
          tone: 'neutral',
        },
      ],
      context:
        'Triage is advisory-level review. It does not claim that the vulnerable package has been fixed.',
      action: {
        label: 'Next step',
        title: 'Review and dismiss if appropriate',
        description: 'Confirm the triage reasoning before changing the finding disposition.',
        buttonLabel: 'Dismiss finding',
        buttonIcon: XCircle,
        kind: 'dismiss',
      },
      disclosureTitle: 'How Security Agent reached this recommendation',
    };
  }

  if (triage) {
    return {
      hero: {
        title: 'Analyze the repository for project risk',
        description:
          triage.needsSandboxReasoning ||
          'Initial review needs repository evidence before Security Agent can assess reachability.',
        icon: Brain,
        tone: 'warning',
      },
      summary: [
        {
          label: 'What is known?',
          value: 'Published vulnerability',
          detail: 'The package matches an affected version range',
          icon: ShieldAlert,
          tone: 'warning',
        },
        {
          label: 'What is missing?',
          value: 'Repository evidence',
          detail: 'Project-specific reachability is unknown',
          icon: Brain,
          tone: 'warning',
        },
        {
          label: 'What should I do?',
          value: 'Analyze repository',
          detail: 'Security Agent will check usage and fix options',
          icon: Sparkles,
          tone: 'neutral',
        },
      ],
      context:
        'Initial advisory review is not enough to confirm project-specific risk or start automatic remediation.',
      action: {
        label: 'Next step',
        title: 'Check repository risk and fix options',
        description:
          'Run codebase analysis to check affected feature usage and identify a safe response.',
        buttonLabel: 'Analyze repository',
        buttonIcon: Brain,
        kind: 'start-analysis',
        primary: true,
      },
      disclosureTitle: 'What initial review found',
    };
  }

  return {
    hero: {
      title: 'Repository risk has not been analyzed',
      description:
        'The source advisory identifies a vulnerable package. Security Agent needs repository evidence to assess whether application code can reach it.',
      icon: Brain,
      tone: 'neutral',
    },
    summary: [
      {
        label: 'What is known?',
        value: 'Published vulnerability',
        detail: `${finding.package_name} matches the affected range`,
        icon: ShieldAlert,
        tone: 'warning',
      },
      {
        label: 'What is missing?',
        value: 'Repository analysis',
        detail: 'Project-specific reachability is unknown',
        icon: Brain,
        tone: 'warning',
      },
      {
        label: 'What should I do?',
        value: 'Analyze repository',
        detail: 'Security Agent will check usage and fix options',
        icon: Sparkles,
        tone: 'neutral',
      },
    ],
    context:
      'Published severity does not prove this repository is exploitable. Codebase analysis provides project-specific evidence.',
    action: {
      label: 'Next step',
      title: 'Determine project risk',
      description:
        'Analyze the repository to check whether application code can reach the affected feature.',
      buttonLabel: 'Analyze repository',
      buttonIcon: Brain,
      kind: 'start-analysis',
      primary: true,
    },
    disclosureTitle: 'What analysis will check',
  };
}

function getAnalysisSteps(
  finding: SecurityFinding,
  analysis: FindingAnalysis,
  analysisStatus: string | null
): ProgressStep[] {
  const triage = analysis?.triage;
  const sandbox = analysis?.sandboxAnalysis;
  const steps: ProgressStep[] = [
    {
      title: 'Found the affected package',
      detail: `${finding.package_name} matches the published vulnerable version range.`,
      state: 'done',
    },
  ];

  if (triage) {
    steps.push({
      title: 'Completed initial advisory review',
      detail:
        triage.needsSandboxReasoning || `Triage completed with ${triage.confidence} confidence.`,
      state: 'done',
    });
  } else if (analysisStatus === 'failed') {
    steps.push({
      title: 'Initial analysis failed',
      detail: 'Security Agent could not complete repository review.',
      state: 'error',
    });
    return steps;
  } else if (analysisStatus === 'pending' || analysisStatus === 'running') {
    steps.push({
      title: 'Initial review in progress',
      detail: 'Security Agent is gathering evidence for the project-specific result.',
      state: analysisStatus === 'running' ? 'running' : 'waiting',
    });
  } else {
    steps.push({
      title: 'Review the advisory',
      detail: 'Triage will determine whether repository analysis is needed.',
      state: 'pending',
    });
  }

  if (sandbox) {
    steps.push({
      title: 'Checked repository usage',
      detail:
        sandbox.usageLocations.length > 0
          ? `Security Agent recorded ${sandbox.usageLocations.length} relevant code ${sandbox.usageLocations.length === 1 ? 'location' : 'locations'}.`
          : 'Security Agent searched the repository for affected feature usage.',
      state: 'done',
    });
    steps.push({
      title:
        sandbox.extractionStatus === 'failed'
          ? 'Structured result needs review'
          : sandbox.isExploitable === true
            ? 'Confirmed a reachable path'
            : sandbox.isExploitable === false
              ? 'Found no reachable path'
              : 'Could not confirm exploitability',
      detail:
        sandbox.summary ||
        sandbox.exploitabilityReasoning ||
        'Review the generated technical report for details.',
      state:
        sandbox.extractionStatus === 'failed' || sandbox.isExploitable === 'unknown'
          ? 'attention'
          : sandbox.isExploitable
            ? 'error'
            : 'done',
    });
  } else if (triage?.needsSandboxAnalysis) {
    steps.push({
      title: 'Repository analysis required',
      detail: 'Project-specific usage and reachability still need to be checked.',
      state: 'attention',
    });
  }

  return steps;
}

function getRecordString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function formatValidationEvidence(record: Record<string, unknown>, index: number): string {
  const label =
    getRecordString(record, 'name') ??
    getRecordString(record, 'title') ??
    getRecordString(record, 'command') ??
    getRecordString(record, 'check') ??
    `Validation check ${index + 1}`;
  const result =
    getRecordString(record, 'result') ??
    getRecordString(record, 'status') ??
    getRecordString(record, 'summary');
  return result ? `${label}: ${result}` : label;
}

function FindingAnalysisPanel({
  finding,
  analysis,
  analysisStatus,
  analysisError,
  cliSessionId,
  organizationId,
  interactionState: {
    isAwaitingAnalysisAdmission,
    isAnalyzing,
    isRestartingAnalysis,
    analysisActionDisabled,
    analysisActionTitle,
    canDismiss,
    canStartRemediation,
    isAwaitingRemediationStart,
  },
  onStartAnalysis,
  onRestartAnalysis,
  onStartCodebaseAnalysis,
  onStartRemediation,
  onDismiss,
  onSelectTab,
}: FindingAnalysisProps) {
  const canRestartAnalysis = analysisStatus === 'running' && finding.status === 'open';
  const presentation = getAnalysisPresentation({
    finding,
    analysis,
    analysisStatus,
    analysisError,
    isAwaitingAnalysisAdmission,
    canStartRemediation,
  });
  const sessionHref = cliSessionId
    ? organizationId
      ? `/organizations/${organizationId}/cloud/chat?sessionId=${cliSessionId}`
      : `/cloud/chat?sessionId=${cliSessionId}`
    : null;
  const sandbox = analysis?.sandboxAnalysis;
  const technicalMarkdown = sandbox?.rawMarkdown || analysis?.rawMarkdown;
  const analysisSteps = getAnalysisSteps(finding, analysis, analysisStatus);
  const ActionIcon = presentation.action.buttonIcon;
  const canShowAction =
    presentation.action.kind !== 'none' &&
    !(presentation.action.kind === 'cloud-agent' && !sessionHref) &&
    !(presentation.action.kind === 'source' && !finding.dependabot_html_url) &&
    !(presentation.action.kind === 'dismiss' && !canDismiss);

  const actionButton = canShowAction && ActionIcon && presentation.action.buttonLabel && (
    <Button
      variant={presentation.action.primary ? 'default' : 'outline'}
      className="h-control-touch"
      disabled={
        ((presentation.action.kind === 'start-analysis' ||
          presentation.action.kind === 'retry-analysis') &&
          analysisActionDisabled) ||
        (presentation.action.kind === 'start-remediation' && isAwaitingRemediationStart)
      }
      title={
        presentation.action.kind === 'start-analysis' ||
        presentation.action.kind === 'retry-analysis'
          ? analysisActionTitle
          : undefined
      }
      onClick={() => {
        if (presentation.action.kind === 'start-analysis') onStartCodebaseAnalysis();
        if (presentation.action.kind === 'retry-analysis') {
          onStartAnalysis({ retrySandboxOnly: Boolean(analysis?.triage) });
        }
        if (presentation.action.kind === 'start-remediation') onStartRemediation();
        if (presentation.action.kind === 'view-remediation') onSelectTab('remediation');
        if (presentation.action.kind === 'dismiss') onDismiss();
      }}
      asChild={presentation.action.kind === 'source' || presentation.action.kind === 'cloud-agent'}
    >
      {presentation.action.kind === 'source' && finding.dependabot_html_url ? (
        <a href={finding.dependabot_html_url} target="_blank" rel="noopener noreferrer">
          <ActionIcon aria-hidden="true" />
          {presentation.action.buttonLabel}
        </a>
      ) : presentation.action.kind === 'cloud-agent' && sessionHref ? (
        <Link href={sessionHref}>
          <ActionIcon aria-hidden="true" />
          {presentation.action.buttonLabel}
        </Link>
      ) : (
        <>
          {isAnalyzing &&
          (presentation.action.kind === 'start-analysis' ||
            presentation.action.kind === 'retry-analysis') ? (
            <LoadingSpinner />
          ) : isAwaitingRemediationStart && presentation.action.kind === 'start-remediation' ? (
            <LoadingSpinner />
          ) : (
            <ActionIcon aria-hidden="true" />
          )}
          {isAwaitingRemediationStart && presentation.action.kind === 'start-remediation'
            ? 'Queueing remediation'
            : presentation.action.buttonLabel}
        </>
      )}
    </Button>
  );

  return (
    <TabsContent value="analysis" className="m-0 focus-visible:ring-inset">
      <div className="space-y-6">
        <FindingOutcome {...presentation.hero} />
        <FindingActionSection
          label={presentation.action.label}
          title={presentation.action.title}
          description={presentation.action.description}
          statusMessage={
            presentation.action.kind === 'start-analysis' ||
            presentation.action.kind === 'retry-analysis'
              ? analysisActionTitle
              : undefined
          }
        >
          {actionButton}
          {canRestartAnalysis && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="h-control-touch"
                  disabled={isRestartingAnalysis}
                >
                  {isRestartingAnalysis ? <LoadingSpinner /> : <RefreshCw aria-hidden="true" />}
                  {isRestartingAnalysis ? 'Restarting analysis' : 'Restart analysis'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restart this analysis?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Security Agent will stop waiting for the current run and queue a new analysis.
                    Any result that arrives from the current run will be ignored.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="h-control-touch">Keep waiting</AlertDialogCancel>
                  <DialogClose asChild>
                    <AlertDialogAction
                      className="h-control-touch"
                      disabled={isRestartingAnalysis}
                      onClick={onRestartAnalysis}
                    >
                      Restart analysis
                    </AlertDialogAction>
                  </DialogClose>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {sessionHref && presentation.action.kind !== 'cloud-agent' && (
            <Button variant="ghost" className="h-control-touch" asChild>
              <Link href={sessionHref}>
                <CircleHelp aria-hidden="true" />
                Inspect analysis
              </Link>
            </Button>
          )}
        </FindingActionSection>

        <SummaryGrid title="What this means" items={presentation.summary} />
        <FindingContextNote>{presentation.context}</FindingContextNote>

        <Accordion type="single" collapsible>
          <AccordionItem value="decision" className="border-border border-t">
            <AccordionTrigger className="min-h-control-touch py-3 no-underline hover:no-underline">
              {presentation.disclosureTitle}
            </AccordionTrigger>
            <AccordionContent className="pb-5">
              <ol className="max-w-2xl space-y-3">
                {analysisSteps.map((step, index) => (
                  <ProgressStepRow key={`${step.title}-${index}`} step={step} index={index} />
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>

          {(sandbox || technicalMarkdown) && (
            <AccordionItem value="technical" className="border-border">
              <AccordionTrigger className="min-h-control-touch py-3 no-underline hover:no-underline">
                Technical evidence and generated report
              </AccordionTrigger>
              <AccordionContent className="pb-5">
                <div className="space-y-6">
                  {sandbox && (
                    <dl className="type-body grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                      <DetailFactItem
                        fact={{
                          label: 'Affected package',
                          value: `${finding.package_name}${finding.vulnerable_version_range ? ` ${finding.vulnerable_version_range}` : ''}`,
                          mono: true,
                        }}
                      />
                      <DetailFactItem
                        fact={{
                          label: 'Recommendation',
                          value: sandbox.suggestedAction.replace(/_/g, ' '),
                        }}
                      />
                      <DetailFactItem
                        fact={{
                          label: 'Analysis model',
                          value: sandbox.modelUsed || analysis?.analysisModel || 'Not recorded',
                          mono: Boolean(sandbox.modelUsed || analysis?.analysisModel),
                        }}
                      />
                      <DetailFactItem
                        fact={{
                          label: 'Analyzed',
                          value: formatUtcDate(sandbox.analysisAt),
                          mono: true,
                        }}
                      />
                    </dl>
                  )}

                  {sandbox && sandbox.usageLocations.length > 0 && (
                    <UsageLocations locations={sandbox.usageLocations} />
                  )}

                  {sandbox?.suggestedFix && (
                    <div className="max-w-[68ch]">
                      <h5 className="type-body font-medium">Suggested fix</h5>
                      <p className="text-muted-foreground type-body mt-1">{sandbox.suggestedFix}</p>
                    </div>
                  )}

                  {technicalMarkdown && (
                    <div className="border-border border-t pt-5">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <h5 className="type-body font-medium">Full generated report</h5>
                        {analysis?.analyzedAt && (
                          <span className="text-muted-foreground type-code">
                            {formatUtcDate(analysis.analyzedAt)}
                          </span>
                        )}
                      </div>
                      <MarkdownProse
                        markdown={technicalMarkdown}
                        className="text-muted-foreground"
                      />
                    </div>
                  )}
                </div>
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </div>
    </TabsContent>
  );
}

function UsageLocations({ locations }: { locations: string[] }) {
  const [showAll, setShowAll] = useState(false);
  const uniqueLocations = [...new Set(locations)];
  const visibleLocations = showAll ? uniqueLocations : uniqueLocations.slice(0, 2);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h5 className="type-body font-medium">Where this was found</h5>
        <span className="text-muted-foreground type-code">
          {uniqueLocations.length} code {uniqueLocations.length === 1 ? 'location' : 'locations'}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {visibleLocations.map(location => (
          <li
            key={location}
            className="bg-surface-inset text-syntax-plain type-code flex min-w-0 items-start gap-2 rounded-md px-3 py-2"
          >
            <FileCode2 className="size-icon-sm mt-0.5 shrink-0" aria-hidden="true" />
            <span className="break-all">{location}</span>
          </li>
        ))}
      </ul>
      {uniqueLocations.length > 2 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-control-default mt-2 px-2"
          onClick={() => setShowAll(current => !current)}
        >
          {showAll ? 'Show fewer locations' : `Show all ${uniqueLocations.length} locations`}
        </Button>
      )}
    </div>
  );
}

type RemediationPresentationSummary = {
  prUrl: string | null;
  prNumber: number | null;
  prDraft: boolean | null;
  failureCode: string | null;
  blockedReason: string | null;
};

function getRemediationPresentation({
  status,
  finding,
  latestAttempt,
  summary,
  canStart,
  unavailableReason,
  unavailableCopy,
  isAwaitingStart,
}: {
  status: string | null;
  finding: SecurityFinding;
  latestAttempt: RemediationAttempt | null;
  summary: RemediationPresentationSummary;
  canStart: boolean;
  unavailableReason: string | null | undefined;
  unavailableCopy: string | null;
  isAwaitingStart: boolean;
}): RemediationPresentation {
  const cancellationRequested = Boolean(latestAttempt?.cancellationRequestedAt);
  const requester = latestAttempt?.origin === 'manual' ? 'User request' : 'Security Agent';
  const prUrl = latestAttempt?.prUrl ?? summary.prUrl;
  const prNumber = latestAttempt?.prNumber ?? summary.prNumber;
  const prDraft = latestAttempt?.prDraft ?? summary.prDraft;
  const failureCode = latestAttempt?.failureCode ?? summary.failureCode;
  const blockedReason = latestAttempt?.blockedReason ?? summary.blockedReason;

  if (isAwaitingStart) {
    return {
      hero: {
        title: 'Queueing remediation',
        description:
          'Security Agent is creating the remediation attempt and reserving its repository branch.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: 'Request in progress',
          detail: 'The attempt is not persisted yet',
          icon: Clock3,
          tone: 'warning',
        },
        {
          label: 'How did it start?',
          value: 'Manual request',
          detail: 'Duplicate starts remain suppressed',
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'What happens next?',
          value: 'Cloud Agent queue',
          detail: 'Status refreshes automatically',
          icon: Sparkles,
          tone: 'neutral',
        },
      ],
      context:
        'Starting remediation creates an attempt. It does not mark the Security Finding fixed.',
      action: {
        label: 'Current status',
        title: 'Creating the remediation attempt',
        description: 'Wait for Security Agent to confirm the queued attempt.',
      },
      disclosureTitle: 'Remediation progress',
      steps: [
        {
          title: 'Create remediation attempt',
          detail: 'Security Agent is validating and saving the request.',
          state: 'running',
        },
        {
          title: 'Wait for Cloud Agent',
          detail: 'Execution begins after the request is accepted.',
          state: 'pending',
        },
      ],
    };
  }

  if (cancellationRequested && isActiveRemediationStatus(status)) {
    return {
      hero: {
        title: 'Cancellation has been requested',
        description:
          'Security Agent asked Cloud Agent to stop. The attempt remains active until Cloud Agent confirms cancellation or returns another final result.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: 'Waiting for confirmation',
          detail: 'The attempt is not cancelled yet',
          icon: Clock3,
          tone: 'warning',
        },
        {
          label: 'Cancellation requested',
          value: latestAttempt?.cancellationRequestedAt
            ? formatUtcDate(latestAttempt.cancellationRequestedAt)
            : 'Recently',
          detail: 'Security Agent accepted the request',
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'Possible outcome',
          value: 'Cancelled or PR opened',
          detail: 'A pull request can still win the race',
          icon: GitPullRequest,
          tone: 'warning',
        },
      ],
      context:
        'Cancellation is best effort. If Cloud Agent opens a verified pull request before stopping, Security Agent will show that result.',
      action: {
        label: 'Current status',
        title: 'Waiting for Cloud Agent',
        description:
          'No further action is available until Cloud Agent confirms cancellation or returns a pull request.',
      },
      disclosureTitle: 'Cancellation progress',
      steps: [
        {
          title: 'Remediation started',
          detail: 'Cloud Agent began repository work.',
          state: 'done',
        },
        {
          title: 'Cancellation requested',
          detail: 'Security Agent accepted the request and asked Cloud Agent to interrupt.',
          state: 'done',
        },
        {
          title: 'Waiting for Cloud Agent',
          detail: 'Cloud Agent has not confirmed interruption or returned a pull request.',
          state: 'waiting',
        },
      ],
    };
  }

  if (!status && canStart) {
    return {
      hero: {
        title: 'Ready to prepare a fix',
        description: `Security Agent can ask Cloud Agent to update ${finding.package_name}, review affected usage, and open a pull request for your team.`,
        icon: GitPullRequest,
        tone: 'neutral',
      },
      summary: [
        {
          label: 'Why available?',
          value: 'Concrete fix path',
          detail: 'Analysis supports a user-reviewed repository change',
          icon: ShieldCheck,
          tone: 'success',
        },
        {
          label: 'How does it start?',
          value: 'Manual request',
          detail: 'This action is independent of Auto Remediation',
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'What happens next?',
          value: 'Review a pull request',
          detail: 'The finding remains open until source sync',
          icon: GitPullRequest,
          tone: 'neutral',
        },
      ],
      context:
        'Starting remediation creates a Security Remediation Attempt. It does not mark the finding fixed.',
      action: {
        label: 'Next step',
        title: 'Prepare a fix',
        description:
          'Cloud Agent will make the smallest safe change it can identify, run focused checks, and open a pull request for review.',
      },
      disclosureTitle: 'Why remediation is available',
      steps: [
        {
          title: 'Finding is still open',
          detail: 'GitHub continues to report the vulnerable package in this repository.',
          state: 'done',
        },
        {
          title: 'Analysis is current',
          detail: 'The latest codebase analysis matches current finding data.',
          state: 'done',
        },
        {
          title: 'A concrete response is available',
          detail: 'Analysis provides enough evidence for a user-reviewed remediation attempt.',
          state: 'done',
        },
        {
          title: 'No remediation is active',
          detail: 'No other attempt or known remediation pull request blocks a new start.',
          state: 'done',
        },
      ],
    };
  }

  if (!status) {
    const analysisRequired = isCodebaseAnalysisRequiredReason(unavailableReason);
    return {
      hero: {
        title: analysisRequired ? 'Analyze the repository first' : 'Remediation is unavailable',
        description:
          unavailableCopy ||
          'Security Agent cannot start a remediation attempt for this finding in its current state.',
        icon: analysisRequired ? Brain : Ban,
        tone: 'warning',
      },
      summary: [
        {
          label: 'What is known?',
          value: 'Published vulnerability',
          detail: 'The source advisory remains available',
          icon: ShieldAlert,
          tone: 'warning',
        },
        {
          label: 'What is missing?',
          value: analysisRequired ? 'Repository analysis' : 'An eligible fix path',
          detail: unavailableCopy || 'Current safety gates block a new attempt',
          icon: analysisRequired ? Brain : Ban,
          tone: 'warning',
        },
        {
          label: 'What should I do?',
          value: analysisRequired ? 'Analyze repository' : 'Review finding state',
          detail: 'Resolve the recorded blocker before starting remediation',
          icon: Search,
          tone: 'neutral',
        },
      ],
      context:
        'Security Agent derives remediation availability from server-provided safety and policy checks.',
      action: {
        label: 'Next step',
        title: analysisRequired ? 'Check repository risk and fix options' : 'Resolve the blocker',
        description:
          unavailableCopy || 'Review analysis and finding status before trying remediation again.',
      },
      disclosureTitle: analysisRequired
        ? 'What blocks remediation'
        : 'Why remediation is unavailable',
      steps: [
        {
          title: 'Source advisory is available',
          detail: `${finding.package_name} matches the published affected range.`,
          state: 'done',
        },
        {
          title: analysisRequired
            ? 'Repository analysis is required'
            : 'A safety gate blocks remediation',
          detail: unavailableCopy || 'Security Agent cannot safely admit a new attempt.',
          state: 'attention',
        },
        {
          title: 'Remediation decision is pending',
          detail: 'A new attempt remains unavailable until the blocker is resolved.',
          state: 'pending',
        },
      ],
    };
  }

  if (status === 'queued') {
    return {
      hero: {
        title: 'Remediation is queued',
        description:
          'Security Agent accepted the request. Cloud Agent will begin when execution capacity is available.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: 'Waiting for capacity',
          detail: 'No repository changes have started',
          icon: Clock3,
          tone: 'warning',
        },
        {
          label: 'Attempt started by',
          value: requester,
          detail: formatRemediationOrigin(latestAttempt?.origin ?? 'manual'),
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'Next update',
          value: 'Cloud Agent starts',
          detail: 'Status refreshes automatically',
          icon: Sparkles,
          tone: 'neutral',
        },
      ],
      context:
        'Only one active remediation attempt can exist for this finding. Another start is unavailable while this attempt is queued.',
      action: {
        label: 'Attempt controls',
        title: 'Manage this attempt',
        description:
          'You can cancel before Cloud Agent starts if this remediation is no longer needed.',
      },
      disclosureTitle: 'Remediation progress',
      steps: [
        {
          title: 'Request accepted',
          detail: `Security Agent created attempt #${latestAttempt?.attemptNumber ?? 1}.`,
          state: 'done',
        },
        {
          title: 'Waiting for Cloud Agent',
          detail: 'The attempt will start when execution capacity is available.',
          state: 'waiting',
        },
        {
          title: 'Prepare repository change',
          detail: 'Cloud Agent has not started repository work.',
          state: 'pending',
        },
        {
          title: 'Open pull request',
          detail: 'No pull request exists yet.',
          state: 'pending',
        },
      ],
    };
  }

  if (status === 'launching') {
    return {
      hero: {
        title: 'Cloud Agent is starting',
        description:
          'Security Agent claimed the queued attempt and is opening the isolated session that will prepare the repository change.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: 'Launching session',
          detail: 'Repository work has not been confirmed yet',
          icon: Sparkles,
          tone: 'warning',
        },
        {
          label: 'Attempt started by',
          value: requester,
          detail: formatRemediationOrigin(latestAttempt?.origin ?? 'manual'),
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'Next update',
          value: 'Repository work begins',
          detail: 'Status refreshes automatically',
          icon: GitBranch,
          tone: 'neutral',
        },
      ],
      context:
        'Launching is an active Security Remediation Attempt. A launch failure can return the attempt to queued or end it as failed.',
      action: {
        label: 'Attempt controls',
        title: 'Manage this attempt',
        description:
          'You can request cancellation while Security Agent finishes starting the session.',
      },
      disclosureTitle: 'Remediation progress',
      steps: [
        {
          title: 'Request accepted',
          detail: `Security Agent created attempt #${latestAttempt?.attemptNumber ?? 1}.`,
          state: 'done',
        },
        {
          title: 'Cloud Agent session starting',
          detail: 'The attempt is creating an isolated execution session.',
          state: 'running',
        },
        {
          title: 'Prepare repository change',
          detail: 'Repository work has not started yet.',
          state: 'pending',
        },
        {
          title: 'Open pull request',
          detail: 'No pull request exists yet.',
          state: 'pending',
        },
      ],
    };
  }

  if (status === 'running') {
    return {
      hero: {
        title: 'Cloud Agent is preparing a fix',
        description:
          'The agent is updating the dependency, reviewing affected usage, and running focused validation before deciding whether to open a pull request.',
        icon: Loader2,
        tone: 'warning',
        spinning: true,
      },
      summary: [
        {
          label: 'Current state',
          value: 'Repository work',
          detail: 'Changes and validation are in progress',
          icon: Wrench,
          tone: 'warning',
        },
        {
          label: 'Attempt started by',
          value: requester,
          detail: formatRemediationOrigin(latestAttempt?.origin ?? 'manual'),
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'Expected outcome',
          value: 'Pull request or explanation',
          detail: 'No-change and failure outcomes stay explicit',
          icon: GitPullRequest,
          tone: 'neutral',
        },
      ],
      context:
        'A running remediation does not change finding status. The source record remains open until GitHub reports it fixed or it is dismissed.',
      action: {
        label: 'Attempt controls',
        title: 'Manage this attempt',
        description:
          'Status updates automatically. Cancellation asks Cloud Agent to stop but cannot guarantee it stops before opening a pull request.',
      },
      disclosureTitle: 'Remediation progress',
      steps: [
        {
          title: 'Request accepted',
          detail: `Security Agent created attempt #${latestAttempt?.attemptNumber ?? 1}.`,
          state: 'done',
        },
        {
          title: 'Cloud Agent started',
          detail: 'The isolated session and remediation branch are ready.',
          state: 'done',
        },
        {
          title: 'Prepare and validate change',
          detail: `Cloud Agent is working on ${finding.package_name} and affected usage.`,
          state: 'running',
        },
        {
          title: 'Open pull request',
          detail: 'No verified pull request exists yet.',
          state: 'pending',
        },
      ],
    };
  }

  if (status === 'pr_opened') {
    const draft = Boolean(prDraft);
    return {
      hero: {
        title: draft
          ? 'Draft remediation pull request is ready'
          : 'Remediation pull request is ready',
        description: draft
          ? 'Cloud Agent prepared a concrete fix, but incomplete validation or recorded risk needs reviewer attention.'
          : `Cloud Agent prepared a repository change and opened${prNumber ? ` pull request #${prNumber}` : ' a pull request'} for team review.`,
        icon: GitPullRequest,
        tone: draft ? 'warning' : 'success',
      },
      summary: [
        {
          label: 'Outcome',
          value: `${draft ? 'Draft ' : ''}PR${prNumber ? ` #${prNumber}` : ' opened'}`,
          detail: 'Expected repository and remediation branch recorded',
          icon: GitPullRequest,
          tone: 'success',
        },
        {
          label: 'Validation',
          value: latestAttempt?.validationEvidence?.length
            ? 'Evidence recorded'
            : 'Review required',
          detail: draft
            ? latestAttempt?.draftReason || 'Validation or risk requires reviewer attention'
            : 'Review recorded checks before merging',
          icon: FileCheck2,
          tone: draft ? 'warning' : 'success',
        },
        {
          label: 'Finding state',
          value: 'Still open',
          detail: 'GitHub confirms when the vulnerability is fixed',
          icon: ShieldAlert,
          tone: 'warning',
        },
      ],
      context:
        'A pull request is not the same as a fixed finding. The finding stays open until GitHub reports the vulnerability resolved.',
      action: {
        label: 'Next step',
        title: draft ? 'Review validation gaps and code changes' : 'Review the pull request',
        description: draft
          ? latestAttempt?.draftReason ||
            'Run missing validation and review recorded risks before marking the pull request ready.'
          : 'Review the dependency update and related code changes before merging into the default branch.',
      },
      disclosureTitle: draft ? 'Why the pull request is a draft' : 'How remediation completed',
      steps: [
        {
          title: 'Prepared a concrete fix',
          detail: 'Cloud Agent recorded a repository change for this finding.',
          state: 'done',
        },
        {
          title: 'Ran available validation',
          detail: latestAttempt?.validationEvidence?.length
            ? `${latestAttempt.validationEvidence.length} validation ${latestAttempt.validationEvidence.length === 1 ? 'record' : 'records'} available in attempt history.`
            : 'No structured validation evidence was recorded.',
          state: draft ? 'attention' : 'done',
        },
        {
          title: 'Verified pull request outcome',
          detail: prNumber
            ? `Pull request #${prNumber} belongs to the recorded remediation attempt.`
            : 'A pull request URL is recorded for this remediation attempt.',
          state: 'done',
        },
      ],
    };
  }

  if (status === 'blocked') {
    return {
      hero: {
        title: 'Remediation was blocked',
        description:
          blockedReason ||
          'Security Agent intentionally stopped before creating a competing or unsafe repository change.',
        icon: Ban,
        tone: 'warning',
      },
      summary: [
        {
          label: 'Block reason',
          value: blockedReason || 'Safety gate stopped the attempt',
          detail: 'Security Agent did not continue past the blocker',
          icon: Ban,
          tone: 'warning',
        },
        {
          label: 'Repository outcome',
          value: prUrl ? 'Related pull request recorded' : 'No remediation PR opened',
          detail: 'Review attempt history for context',
          icon: GitBranch,
          tone: 'neutral',
        },
        {
          label: 'What should I do?',
          value: prUrl ? 'Review the existing PR' : 'Resolve the blocker',
          detail: 'Retry only when current safety gates allow it',
          icon: Search,
          tone: 'neutral',
        },
      ],
      context:
        'Blocked is distinct from failed. Security Agent intentionally stopped because proceeding could create unsafe or conflicting work.',
      action: {
        label: 'Next step',
        title: prUrl ? 'Review the existing remediation' : 'Resolve the recorded blocker',
        description:
          blockedReason ||
          'Review the attempt evidence before deciding whether another remediation attempt is appropriate.',
      },
      disclosureTitle: 'Why remediation was blocked',
      steps: [
        {
          title: 'Attempt admitted',
          detail: 'Security Agent accepted remediation for this finding.',
          state: 'done',
        },
        {
          title: 'Checked safety gates',
          detail: blockedReason || 'A blocking condition was detected.',
          state: 'done',
        },
        {
          title: 'Stopped remediation',
          detail: 'Security Agent ended the attempt before unsafe or conflicting work continued.',
          state: 'error',
        },
      ],
    };
  }

  if (status === 'failed') {
    return {
      hero: {
        title: 'Remediation did not complete',
        description:
          latestAttempt?.lastErrorRedacted ||
          'Cloud Agent could not complete the repository change or open a trustworthy pull request.',
        icon: XCircle,
        tone: 'destructive',
      },
      summary: [
        {
          label: 'What happened?',
          value: failureCode?.replace(/_/g, ' ') || 'Attempt failed',
          detail: latestAttempt?.lastErrorRedacted || 'Review attempt details before retrying',
          icon: TriangleAlert,
          tone: 'destructive',
        },
        {
          label: 'Pull request',
          value: 'Not opened',
          detail: 'No trustworthy pull request outcome was recorded',
          icon: GitBranch,
          tone: 'neutral',
        },
        {
          label: 'What should I do?',
          value: 'Resolve the error and retry',
          detail: 'A retry creates a new preserved attempt',
          icon: RefreshCw,
          tone: 'neutral',
        },
      ],
      context:
        'Failure leaves the finding open. Retrying creates a new Security Remediation Attempt and preserves this attempt in history.',
      action: {
        label: 'Next step',
        title: 'Retry after resolving the recorded error',
        description:
          latestAttempt?.lastErrorRedacted ||
          'Review repository access and attempt details before starting another attempt.',
      },
      disclosureTitle: 'What failed',
      steps: [
        {
          title: 'Request accepted',
          detail: `Security Agent created attempt #${latestAttempt?.attemptNumber ?? 1}.`,
          state: 'done',
        },
        {
          title: 'Cloud Agent could not complete remediation',
          detail:
            latestAttempt?.lastErrorRedacted ||
            'The attempt ended before a safe outcome was recorded.',
          state: 'error',
        },
        {
          title: 'No pull request opened',
          detail: 'No verified code change or pull request exists.',
          state: 'pending',
        },
      ],
    };
  }

  if (status === 'no_changes_needed') {
    return {
      hero: {
        title: 'Cloud Agent found no safe change to make',
        description:
          'The attempt ended without a repository change. Security Agent correctly did not open a no-change pull request.',
        icon: CheckCircle2,
        tone: 'neutral',
      },
      summary: [
        {
          label: 'Outcome',
          value: 'No repository changes',
          detail: 'A no-change pull request was not opened',
          icon: Check,
          tone: 'neutral',
        },
        {
          label: 'Finding state',
          value: 'Still open',
          detail: 'Source synchronization controls closure',
          icon: ShieldAlert,
          tone: 'warning',
        },
        {
          label: 'What should I do?',
          value: 'Review source state',
          detail: 'Retry only after new evidence or re-analysis',
          icon: Info,
          tone: 'neutral',
        },
      ],
      context:
        'No changes needed is not the same as fixed. Security Agent does not close the finding or invent a pull request.',
      action: {
        label: 'Next step',
        title: 'No immediate remediation action',
        description:
          'Review the finding. If source data or repository evidence changes, run fresh analysis before retrying.',
      },
      disclosureTitle: 'Why no changes were made',
      steps: [
        {
          title: 'Inspected repository evidence',
          detail: 'Cloud Agent reviewed the current dependency and source state.',
          state: 'done',
        },
        {
          title: 'Found no safe repository change',
          detail: 'The attempt determined that no change should be published.',
          state: 'done',
        },
        {
          title: 'Skipped a no-change pull request',
          detail: 'Cloud Agent correctly ended without creating repository noise.',
          state: 'done',
        },
      ],
    };
  }

  if (status === 'cancelled') {
    return {
      hero: {
        title: 'Remediation was cancelled',
        description:
          'Cloud Agent confirmed interruption before opening a pull request. Any partial session work was not presented as a repository outcome.',
        icon: XCircle,
        tone: 'neutral',
      },
      summary: [
        {
          label: 'Outcome',
          value: 'Cancelled',
          detail: 'Cloud Agent confirmed interruption',
          icon: XCircle,
          tone: 'neutral',
        },
        {
          label: 'Attempt started by',
          value: requester,
          detail: formatRemediationOrigin(latestAttempt?.origin ?? 'manual'),
          icon: UserRound,
          tone: 'neutral',
        },
        {
          label: 'Pull request',
          value: 'Not opened',
          detail: 'No repository outcome was published',
          icon: GitPullRequest,
          tone: 'neutral',
        },
      ],
      context:
        'Cancelled is a terminal attempt outcome, not a finding status. The Security Finding remains open.',
      action: {
        label: 'Next step',
        title: 'Start a new attempt when ready',
        description:
          'Retry remains available only when current analysis and safety gates provide a concrete fix path.',
      },
      disclosureTitle: 'How cancellation completed',
      steps: [
        {
          title: 'Remediation started',
          detail: 'Cloud Agent began repository work.',
          state: 'done',
        },
        {
          title: 'Cancellation requested',
          detail: 'Security Agent asked Cloud Agent to stop the attempt.',
          state: 'done',
        },
        {
          title: 'Interruption confirmed',
          detail: 'Cloud Agent stopped before opening a pull request.',
          state: 'done',
        },
      ],
    };
  }

  return {
    hero: {
      title: 'Review remediation status',
      description: `Security Agent recorded this remediation as ${formatRemediationStatus(status)}.`,
      icon: GitPullRequest,
      tone: 'neutral',
    },
    summary: [
      {
        label: 'Current state',
        value: formatRemediationStatus(status),
        detail: 'Review attempt history for more context',
        icon: GitPullRequest,
        tone: 'neutral',
      },
      {
        label: 'Finding state',
        value: finding.status,
        detail: 'Remediation does not directly close findings',
        icon: ShieldAlert,
        tone: 'warning',
      },
      {
        label: 'Next step',
        value: 'Review recorded evidence',
        detail: 'Use the latest source and attempt state',
        icon: Search,
        tone: 'neutral',
      },
    ],
    context:
      'Security Finding status and Security Remediation status are separate recorded outcomes.',
    action: {
      label: 'Current status',
      title: 'Review remediation history',
      description: 'Use the recorded attempts to understand the current state.',
    },
    disclosureTitle: 'Remediation progress',
    steps: [
      {
        title: 'Remediation status recorded',
        detail: formatRemediationStatus(status),
        state: 'done',
      },
    ],
  };
}

type FindingRemediationProps = {
  finding: SecurityFinding;
  status: string | null;
  summary: RemediationPresentationSummary;
  outcomeSummary: string | null;
  unavailableReason: string | null | undefined;
  unavailableCopy: string | null;
  attempts: RemediationAttempt[];
  canStart: boolean;
  isAwaitingStart: boolean;
  actionStatusMessage?: string;
  action: ReactNode;
};

function FindingRemediation({
  finding,
  status,
  summary,
  outcomeSummary,
  unavailableReason,
  unavailableCopy,
  attempts,
  canStart,
  isAwaitingStart,
  actionStatusMessage,
  action,
}: FindingRemediationProps) {
  const latestAttempt = attempts[0] ?? null;
  const presentation = getRemediationPresentation({
    status,
    finding,
    latestAttempt,
    summary,
    canStart,
    unavailableReason,
    unavailableCopy,
    isAwaitingStart,
  });

  return (
    <TabsContent value="remediation" className="m-0 focus-visible:ring-inset">
      <div className="space-y-6">
        <FindingOutcome {...presentation.hero} />
        {outcomeSummary && !isActiveRemediationStatus(status) && (
          <div className="border-border bg-surface-inset type-body rounded-lg border p-4">
            <div className="text-muted-foreground type-label mb-1">Recorded outcome</div>
            <p>{outcomeSummary}</p>
          </div>
        )}
        <FindingActionSection
          label={presentation.action.label}
          title={presentation.action.title}
          description={presentation.action.description}
          statusMessage={actionStatusMessage}
        >
          {action}
        </FindingActionSection>
        <SummaryGrid title="Remediation summary" items={presentation.summary} />
        <FindingContextNote>{presentation.context}</FindingContextNote>

        <Accordion type="single" collapsible>
          <AccordionItem value="progress" className="border-border border-t">
            <AccordionTrigger className="min-h-control-touch py-3 no-underline hover:no-underline">
              {presentation.disclosureTitle}
            </AccordionTrigger>
            <AccordionContent className="pb-5">
              <ol className="max-w-2xl space-y-3">
                {presentation.steps.map((step, index) => (
                  <ProgressStepRow key={`${step.title}-${index}`} step={step} index={index} />
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>

          {attempts.length > 0 && (
            <AccordionItem value="attempts" className="border-border">
              <AccordionTrigger className="min-h-control-touch py-3 no-underline hover:no-underline">
                Remediation attempt history ({attempts.length})
              </AccordionTrigger>
              <AccordionContent className="pb-5">
                <div className="space-y-3">
                  {attempts.map(attempt => (
                    <AttemptRecord key={attempt.id} attempt={attempt} />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>
      </div>
    </TabsContent>
  );
}

function getAttemptTone(attempt: RemediationAttempt): Tone {
  if (attempt.status === 'pr_opened') return 'success';
  if (attempt.status === 'failed') return 'destructive';
  if (
    attempt.status === 'queued' ||
    attempt.status === 'launching' ||
    attempt.status === 'running' ||
    attempt.status === 'blocked'
  )
    return 'warning';
  return 'neutral';
}

function AttemptRecord({ attempt }: { attempt: RemediationAttempt }) {
  const tone = getAttemptTone(attempt);
  const requestedBy = attempt.origin === 'manual' ? 'Kilo user' : 'Security Agent';
  const outcome = attempt.blockedReason || attempt.lastErrorRedacted;
  const validation = attempt.validationEvidence?.map(formatValidationEvidence) ?? [];

  return (
    <section className="border-border bg-surface-inset rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="type-code">
            #{attempt.attemptNumber}
          </Badge>
          <span
            className={cn('type-label px-status rounded-full border py-1', toneStyles[tone].status)}
          >
            {formatRemediationStatus(attempt.status, attempt.cancellationRequestedAt)}
          </span>
          <span className="text-muted-foreground type-label">
            {formatRemediationOrigin(attempt.origin)}
          </span>
        </div>
        <span className="text-muted-foreground type-code tabular-nums">
          {formatUtcDate(attempt.updatedAt)}
        </span>
      </div>

      <div className="type-body mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailFactItem fact={{ label: 'Attempt started by', value: requestedBy }} />
        <DetailFactItem
          fact={{ label: 'Model', value: attempt.remediationModelSlug, mono: true }}
        />
        <DetailFactItem fact={{ label: 'Branch', value: attempt.branchName, mono: true }} />
        <DetailFactItem
          fact={{
            label: 'Started',
            value: formatUtcDate(attempt.launchedAt || attempt.queuedAt),
            mono: true,
          }}
        />
      </div>

      {outcome && (
        <div className="border-border mt-4 border-t pt-4">
          <div className="text-muted-foreground type-label">Outcome</div>
          <p className="type-body mt-1 max-w-[68ch]">{outcome}</p>
        </div>
      )}

      {validation.length > 0 && (
        <div className="type-body mt-3 flex max-w-[68ch] items-start gap-2">
          <FileCheck2
            className="text-status-success-icon mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div>
            <span className="font-medium">Validation:</span>
            <ul className="text-muted-foreground mt-1 list-inside list-disc">
              {validation.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {(attempt.riskNotes || attempt.draftReason) && (
        <div className="type-body mt-3 flex max-w-[68ch] items-start gap-2">
          <TriangleAlert
            className="text-status-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>
            <span className="font-medium">Reviewer note:</span>{' '}
            <span className="text-muted-foreground">
              {attempt.riskNotes || attempt.draftReason}
            </span>
          </p>
        </div>
      )}

      {attempt.prUrl && (
        <Button variant="link" size="sm" className="h-control-default mt-2 px-0" asChild>
          <a href={attempt.prUrl} target="_blank" rel="noopener noreferrer">
            Open {attempt.prDraft ? 'draft ' : ''}pull request
            {attempt.prNumber ? ` #${attempt.prNumber}` : ''}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </Button>
      )}
    </section>
  );
}

type FindingDetailDialogProps = {
  finding: SecurityFindingWithRemediation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (analysis: FindingAnalysis) => void;
  canDismiss: boolean;
  onOpenFinding: (findingId: string) => void;
  onStartAnalysis: StartFindingAnalysis;
  analysisAtCapacity: boolean;
  organizationId?: string;
  showSla?: boolean;
};

export function FindingDetailDialog({
  finding: initialFinding,
  open,
  onOpenChange,
  onDismiss,
  canDismiss,
  onOpenFinding,
  onStartAnalysis,
  analysisAtCapacity,
  organizationId,
  showSla = true,
}: FindingDetailDialogProps) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const {
    handleStartAnalysis: startAnalysisCommand,
    handleStartRemediation,
    handleRetryRemediation,
    handleCancelRemediation,
    trackUiInteraction,
    startingAnalysisIds,
    startingRemediationIds,
    cancellingRemediationAttemptIds,
  } = useSecurityAgent();
  const trackedOpenFindingIdRef = useRef<string | null>(null);
  const settledAnalysisCompletionRef = useRef<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [tabState, setTabState] = useState<{ findingId: string | null; tab: FindingTab }>({
    findingId: null,
    tab: 'details',
  });
  const findingId = initialFinding?.id;

  useEffect(() => {
    if (!open || !findingId) {
      trackedOpenFindingIdRef.current = null;
      return;
    }
    if (trackedOpenFindingIdRef.current === findingId) return;

    trackedOpenFindingIdRef.current = findingId;
    trackUiInteraction('finding_detail_opened');
  }, [findingId, open, trackUiInteraction]);

  const hasActiveAnalysisStartCommand = findingId ? startingAnalysisIds.has(findingId) : false;
  const isAwaitingRemediationStart = findingId ? startingRemediationIds.has(findingId) : false;

  const pollWhileActive = (query: {
    state: {
      data?: {
        status?: string | null;
        remediationAttempts?: RemediationAttempt[];
      };
    };
  }) => {
    const status = query.state.data?.status;
    const hasActiveRemediation = query.state.data?.remediationAttempts?.some(attempt =>
      isActiveRemediationStatus(attempt.status)
    );
    if (
      hasActiveAnalysisStartCommand ||
      isAwaitingRemediationStart ||
      status === 'pending' ||
      status === 'running' ||
      hasActiveRemediation
    ) {
      return ANALYSIS_POLL_INTERVAL_MS;
    }
    return false as const;
  };

  const { data: orgAnalysisData, refetch: refetchOrgAnalysis } = useQuery({
    ...trpc.organizations.securityAgent.getAnalysis.queryOptions({
      organizationId: organizationId ?? '',
      findingId: findingId ?? '',
    }),
    enabled: open && Boolean(initialFinding) && isOrg,
    refetchInterval: pollWhileActive,
  });
  const { data: personalAnalysisData, refetch: refetchPersonalAnalysis } = useQuery({
    ...trpc.securityAgent.getAnalysis.queryOptions({
      findingId: findingId ?? '',
    }),
    enabled: open && Boolean(initialFinding) && !isOrg,
    refetchInterval: pollWhileActive,
  });
  const analysisData = isOrg ? orgAnalysisData : personalAnalysisData;
  const refetchAnalysis = isOrg ? refetchOrgAnalysis : refetchPersonalAnalysis;
  const analysisSettlementKey =
    findingId && analysisData?.completedAt ? `${findingId}:${analysisData.completedAt}` : null;

  useEffect(() => {
    if (
      !open ||
      !analysisSettlementKey ||
      analysisData?.status !== 'completed' ||
      analysisData.findingState.status !== 'open' ||
      settledAnalysisCompletionRef.current === analysisSettlementKey
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      settledAnalysisCompletionRef.current = analysisSettlementKey;
      void refetchAnalysis();
    }, ANALYSIS_POLL_INTERVAL_MS);

    return () => window.clearTimeout(timeoutId);
  }, [
    analysisData?.findingState.status,
    analysisData?.status,
    analysisSettlementKey,
    open,
    refetchAnalysis,
  ]);

  const finding =
    initialFinding && analysisData
      ? {
          ...initialFinding,
          status: analysisData.findingState.status,
          ignored_reason: analysisData.findingState.ignoredReason,
          ignored_by: analysisData.findingState.ignoredBy,
          fixed_at: analysisData.findingState.fixedAt,
          updated_at: analysisData.findingState.updatedAt,
          analysis_status: analysisData.status,
          analysis_started_at: analysisData.startedAt,
          analysis_completed_at: analysisData.completedAt,
          analysis_error: analysisData.error,
          analysis: analysisData.analysis,
          session_id: analysisData.sessionId,
          cli_session_id: analysisData.cliSessionId,
          remediationSummary: analysisData.remediationSummary,
          remediationCapability: analysisData.remediationCapability,
        }
      : initialFinding;
  if (!finding) return null;

  const selectedTab = tabState.findingId === finding.id ? tabState.tab : 'details';
  const handleTabChange = (value: string) => {
    if (value !== 'details' && value !== 'analysis' && value !== 'remediation') return;
    setTabState({ findingId: finding.id, tab: value });
    scrollContainerRef.current?.scrollTo({ top: 0 });
    if (value === 'analysis') trackUiInteraction('finding_analysis_viewed');
    if (value === 'remediation') trackUiInteraction('finding_remediation_viewed');
  };

  const analysisStatus = analysisData?.status ?? finding.analysis_status;
  const isAwaitingAnalysisAdmission = isAwaitingManualAnalysisAdmission(
    hasActiveAnalysisStartCommand,
    analysisStatus
  );
  const isRestartingAnalysis = hasActiveAnalysisStartCommand && analysisStatus === 'running';
  const analysis = analysisData?.analysis ?? finding.analysis;
  const analysisError = analysisData?.error ?? finding.analysis_error;
  const cliSessionId = analysisData?.cliSessionId ?? finding.cli_session_id;
  const remediationSummary = analysisData?.remediationSummary ?? finding.remediationSummary ?? null;
  const remediationCapability =
    analysisData?.remediationCapability ?? finding.remediationCapability;
  const remediationAttempts = analysisData?.remediationAttempts ?? [];
  const latestHistoryAttempt = remediationAttempts[0] ?? null;
  const effectiveRemediationStatus =
    latestHistoryAttempt?.status ?? remediationSummary?.status ?? null;
  const isEffectiveRemediationActive = isActiveRemediationStatus(effectiveRemediationStatus);
  const effectiveRemediationPrUrl =
    remediationSummary?.prUrl ?? latestHistoryAttempt?.prUrl ?? null;
  const effectiveRemediationOutcomeSummary = isEffectiveRemediationActive
    ? null
    : (remediationSummary?.outcomeSummary ?? null);
  const hasRegisteredRemediationAttempt =
    remediationAttempts.length > 0 ||
    Boolean(remediationSummary?.latestAttemptId ?? remediationSummary?.latestAttempt?.id);
  const activeRemediationAttemptId = isEffectiveRemediationActive
    ? (remediationCapability?.cancelAttemptId ??
      latestHistoryAttempt?.id ??
      remediationSummary?.latestAttemptId ??
      null)
    : null;
  const cancellationRequestedAt = latestHistoryAttempt?.cancellationRequestedAt ?? null;
  const isCancellingRemediation =
    Boolean(activeRemediationAttemptId) &&
    cancellingRemediationAttemptIds.has(activeRemediationAttemptId ?? '');
  const remediationUnavailableCopy =
    remediationCapability &&
    !remediationCapability.canStart &&
    !remediationCapability.canRetry &&
    !remediationCapability.canCancel
      ? getRemediationUnavailableCopy(remediationCapability.startReason)
      : null;
  const effectiveRemediationUnavailableCopy =
    effectiveRemediationStatus === 'pr_opened'
      ? getRemediationUnavailableCopy('pr_already_opened')
      : remediationUnavailableCopy;
  const remediationNeedsAnalysisRefresh =
    !hasRegisteredRemediationAttempt &&
    (remediationCapability?.startReason === 'stale_analysis' ||
      remediationCapability?.retryReason === 'stale_analysis');
  const remediationNeedsCodebaseAnalysis =
    !hasRegisteredRemediationAttempt &&
    !isEffectiveRemediationActive &&
    (isCodebaseAnalysisRequiredReason(remediationCapability?.startReason) ||
      isCodebaseAnalysisRequiredReason(remediationCapability?.retryReason));
  const canStartRemediation =
    Boolean(remediationCapability?.canStart) &&
    !hasRegisteredRemediationAttempt &&
    !isEffectiveRemediationActive;
  const canCancelRemediation = Boolean(activeRemediationAttemptId) && !cancellationRequestedAt;
  const canRetryRemediation =
    Boolean(remediationCapability?.canRetry) &&
    !isEffectiveRemediationActive &&
    effectiveRemediationStatus !== 'pr_opened';
  const isAnalyzing =
    isAwaitingAnalysisAdmission || analysisStatus === 'pending' || analysisStatus === 'running';
  const analysisActionDisabled = isAnalyzing || analysisAtCapacity;
  const canDismissFinding = canDismiss && finding.status === 'open';
  const analysisActionTitle =
    analysisAtCapacity && !isAnalyzing ? manualAnalysisCapacityFullCopy : undefined;
  const remediationAnalysisRefreshLabel = isAwaitingAnalysisAdmission
    ? manualAnalysisAdmissionCopy.pendingLabel
    : analysisStatus === 'pending'
      ? manualAnalysisAdmissionCopy.successTitle
      : analysisStatus === 'running'
        ? 'Analysis running'
        : 'Rerun analysis';
  const codebaseAnalysisActionLabel = isAwaitingAnalysisAdmission
    ? manualAnalysisAdmissionCopy.pendingLabel
    : analysisStatus === 'pending'
      ? manualAnalysisAdmissionCopy.successTitle
      : analysisStatus === 'running'
        ? 'Analysis running'
        : 'Analyze repository';

  const handleStartAnalysis: StartAnalysis = ({
    forceSandbox,
    retrySandboxOnly,
    restartActive,
  } = {}) => {
    onStartAnalysis(finding.id, { forceSandbox, retrySandboxOnly, restartActive });
  };
  const handleRestartAnalysis = () => {
    startAnalysisCommand(finding.id, { restartActive: true });
  };
  const handleStartCodebaseAnalysis = () => {
    handleStartAnalysis({ forceSandbox: true });
  };
  const handleCancelRemediationClick = () => {
    if (activeRemediationAttemptId) handleCancelRemediation(activeRemediationAttemptId, finding.id);
  };
  const handleDismiss = () => onDismiss(analysis);
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setTabState({ findingId: null, tab: 'details' });
    onOpenChange(nextOpen);
  };

  const remediationAction = effectiveRemediationPrUrl ? (
    <Button className="h-control-touch" asChild>
      <a href={effectiveRemediationPrUrl} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden="true" />
        View pull request
      </a>
    </Button>
  ) : isAwaitingRemediationStart ? (
    <Button className="h-control-touch" disabled>
      <LoadingSpinner />
      Queueing remediation
    </Button>
  ) : canCancelRemediation ? (
    <Button
      variant="outline"
      className="h-control-touch"
      onClick={handleCancelRemediationClick}
      disabled={isCancellingRemediation}
    >
      {isCancellingRemediation ? <LoadingSpinner /> : <Square aria-hidden="true" />}
      {isCancellingRemediation ? 'Requesting cancellation' : 'Cancel remediation'}
    </Button>
  ) : canRetryRemediation ? (
    <Button className="h-control-touch" onClick={() => handleRetryRemediation(finding.id)}>
      <RefreshCw aria-hidden="true" />
      Retry remediation
    </Button>
  ) : canStartRemediation ? (
    <Button className="h-control-touch" onClick={() => handleStartRemediation(finding.id)}>
      <Sparkles aria-hidden="true" />
      Start remediation
    </Button>
  ) : remediationNeedsCodebaseAnalysis ? (
    <Button
      className="h-control-touch"
      onClick={handleStartCodebaseAnalysis}
      disabled={analysisActionDisabled}
      title={analysisActionTitle}
    >
      {isAnalyzing ? <LoadingSpinner /> : <Brain aria-hidden="true" />}
      {codebaseAnalysisActionLabel}
    </Button>
  ) : remediationNeedsAnalysisRefresh ? (
    <Button
      className="h-control-touch"
      onClick={() => handleStartAnalysis()}
      disabled={analysisActionDisabled}
      title={analysisActionTitle}
    >
      {isAnalyzing ? <LoadingSpinner /> : <RefreshCw aria-hidden="true" />}
      {remediationAnalysisRefreshLabel}
    </Button>
  ) : null;

  const statuses = [
    { label: 'Severity', ...getSeverityStatus(finding.severity) },
    { label: 'Finding', ...getFindingStatus(finding) },
    { label: 'Analysis', ...getAnalysisStatus(analysis, analysisStatus) },
  ];

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={() => {
          if (document.activeElement instanceof HTMLElement) {
            openerRef.current = document.activeElement;
          }
        }}
        onCloseAutoFocus={event => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (!opener?.isConnected || opener === document.body) return;
          event.preventDefault();
          opener.focus();
        }}
        className="bg-surface-raised max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-3rem)]"
      >
        <Tabs value={selectedTab} onValueChange={handleTabChange} className="contents">
          <header className="border-border border-b px-4 pt-5 sm:px-6 sm:pt-6">
            <div className="relative">
              <div className="min-w-0">
                <DialogTitle className="type-title min-h-control-touch pr-14 leading-tight">
                  {finding.title}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Security Finding for {finding.package_name} in {finding.repo_full_name}
                </DialogDescription>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <code className="bg-surface-inset text-syntax-plain type-code max-w-full break-words rounded-sm px-1.5 py-0.5">
                    {finding.repo_full_name}
                  </code>
                  <span className="text-muted-foreground type-code tabular-nums">
                    Detected {formatUtcDate(finding.first_detected_at, false)}
                  </span>
                  <span className="text-muted-foreground type-code tabular-nums">
                    Updated {formatUtcDate(finding.updated_at, false)}
                  </span>
                </div>
              </div>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-control-touch absolute top-0 right-0"
                  aria-label="Close finding details"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {statuses.map(status => (
                <LabeledStatus
                  key={status.label}
                  label={status.label}
                  value={status.value}
                  tone={status.tone}
                />
              ))}
            </div>

            <nav aria-label="Finding detail sections" className="mt-5 pb-3">
              <TabsList className="border-border bg-surface-raised flex h-auto w-full gap-1 rounded-xl border p-1.5 shadow-sm">
                <TabsTrigger
                  value="details"
                  className="data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected flex-1 gap-1 px-1.5 py-2 data-[state=active]:shadow-sm sm:gap-2 sm:px-3"
                >
                  <Package className="hidden size-4 sm:block" aria-hidden="true" />
                  Details
                </TabsTrigger>
                <TabsTrigger
                  value="analysis"
                  className="data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected flex-1 gap-1 px-1.5 py-2 data-[state=active]:shadow-sm sm:gap-2 sm:px-3"
                >
                  {isAnalyzing ? (
                    <LoadingSpinner className="hidden size-4 sm:block" />
                  ) : (
                    <Brain className="hidden size-4 sm:block" aria-hidden="true" />
                  )}
                  Analysis
                </TabsTrigger>
                <TabsTrigger
                  value="remediation"
                  className="data-[state=active]:border-border-strong data-[state=active]:bg-surface-selected flex-1 gap-1 px-1.5 py-2 data-[state=active]:shadow-sm sm:gap-2 sm:px-3"
                >
                  {isEffectiveRemediationActive ? (
                    <LoadingSpinner className="hidden size-4 sm:block" />
                  ) : (
                    <GitPullRequest className="hidden size-4 sm:block" aria-hidden="true" />
                  )}
                  Remediation
                </TabsTrigger>
              </TabsList>
            </nav>
          </header>

          <div
            ref={scrollContainerRef}
            className="min-h-0 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-6 sm:py-6"
          >
            <FindingDetails
              finding={finding}
              analysis={analysis}
              showSla={showSla}
              canDismiss={canDismissFinding}
              analysisActionDisabled={analysisActionDisabled}
              analysisActionTitle={analysisActionTitle}
              onDismiss={handleDismiss}
              onOpenFinding={onOpenFinding}
              onSelectTab={handleTabChange}
              onStartCodebaseAnalysis={handleStartCodebaseAnalysis}
            />
            <FindingAnalysisPanel
              finding={finding}
              analysis={analysis}
              analysisStatus={analysisStatus}
              analysisError={analysisError}
              cliSessionId={cliSessionId}
              organizationId={organizationId}
              interactionState={{
                isAwaitingAnalysisAdmission,
                isAnalyzing,
                isRestartingAnalysis,
                analysisActionDisabled,
                analysisActionTitle,
                canDismiss: canDismissFinding,
                canStartRemediation,
                isAwaitingRemediationStart,
              }}
              onStartAnalysis={handleStartAnalysis}
              onRestartAnalysis={handleRestartAnalysis}
              onStartCodebaseAnalysis={handleStartCodebaseAnalysis}
              onStartRemediation={() => handleStartRemediation(finding.id)}
              onDismiss={handleDismiss}
              onSelectTab={handleTabChange}
            />
            <FindingRemediation
              finding={finding}
              status={effectiveRemediationStatus}
              summary={{
                prUrl: remediationSummary?.prUrl ?? null,
                prNumber: remediationSummary?.prNumber ?? null,
                prDraft: remediationSummary?.prDraft ?? null,
                failureCode: remediationSummary?.failureCode ?? null,
                blockedReason: remediationSummary?.blockedReason ?? null,
              }}
              outcomeSummary={effectiveRemediationOutcomeSummary}
              unavailableReason={remediationCapability?.startReason}
              unavailableCopy={effectiveRemediationUnavailableCopy}
              attempts={remediationAttempts}
              canStart={canStartRemediation}
              isAwaitingStart={isAwaitingRemediationStart}
              actionStatusMessage={
                remediationNeedsCodebaseAnalysis || remediationNeedsAnalysisRefresh
                  ? analysisActionTitle
                  : undefined
              }
              action={remediationAction}
            />
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
