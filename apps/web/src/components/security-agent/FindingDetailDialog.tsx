'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from './SeverityBadge';
import { FindingStatusBadge } from './FindingStatusBadge';
import { ExploitabilityBadge } from './ExploitabilityBadge';
import { MarkdownProse } from './MarkdownProse';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import {
  ExternalLink,
  Package,
  Clock,
  CheckCircle2,
  XCircle,
  Brain,
  Loader2,
  Zap,
} from 'lucide-react';
import type { SecurityFinding } from '@kilocode/db/schema';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSecurityAgent } from './SecurityAgentContext';
import { securityAgentCommandAdmissionCopy } from './security-agent-command-copy';

type Severity = 'critical' | 'high' | 'medium' | 'low';
type FindingAnalysis = SecurityFinding['analysis'];
type StartAnalysis = (options?: { retrySandboxOnly?: boolean }) => void;

const ANALYSIS_POLL_INTERVAL_MS = 3000;
const statusPanelClassName = 'rounded-lg border border-border bg-muted/40 p-3';
const linkClassName =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex rounded-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none';

function isSeverity(value: string): value is Severity {
  return ['critical', 'high', 'medium', 'low'].includes(value);
}

function LoadingSpinner({ className = 'size-4' }: { className?: string }) {
  return (
    <Loader2
      className={`${className} animate-spin motion-reduce:animate-none`}
      aria-hidden="true"
    />
  );
}

function AnalysisStatusIcon({
  status,
  fallback,
}: {
  status: string | null | undefined;
  fallback: React.ReactNode;
}) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="size-3.5 text-green-400" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="size-3.5 text-red-400" aria-hidden="true" />;
    case 'running':
    case 'pending':
      return <LoadingSpinner className="size-3.5 text-yellow-400" />;
    default:
      return <>{fallback}</>;
  }
}

type FindingDetailDialogProps = {
  finding: SecurityFinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  canDismiss: boolean;
  organizationId?: string;
};

type FindingHeaderProps = {
  finding: SecurityFinding;
  analysis: FindingAnalysis;
  analysisStatus: string | null;
};

function FindingHeader({ finding, analysis, analysisStatus }: FindingHeaderProps) {
  const severity: Severity = isSeverity(finding.severity) ? finding.severity : 'medium';
  const isOverdue =
    finding.status === 'open' && finding.sla_due_at && isPast(new Date(finding.sla_due_at));

  return (
    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
      <DialogHeader className="min-w-0 flex-1 text-left">
        <DialogTitle className="break-words text-xl">{finding.title}</DialogTitle>
        <div className="text-muted-foreground space-y-2 text-sm">
          <code className="bg-muted text-foreground inline-block max-w-full break-all rounded-sm px-1.5 py-0.5 font-mono text-xs">
            {finding.repo_full_name}
          </code>
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs tabular-nums">
            <span>Detected {format(new Date(finding.first_detected_at), 'PPP')}</span>
            <span>Synced {format(new Date(finding.last_synced_at), 'PPP')}</span>
          </div>
        </div>
        <DialogDescription className="sr-only">
          {finding.package_name} ({finding.package_ecosystem})
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col items-start gap-2 sm:shrink-0 sm:items-end sm:pt-4">
        <div className="flex max-w-full flex-wrap items-center gap-2 sm:justify-end">
          <SeverityBadge severity={severity} />
          <FindingStatusBadge status={finding.status} />
          <ExploitabilityBadge analysis={analysis} />
        </div>
        <FindingTimeline finding={finding} isOverdue={Boolean(isOverdue)} />
        <span className="sr-only" aria-live="polite">
          Analysis status: {analysisStatus ?? 'not started'}
        </span>
      </div>
    </div>
  );
}

function FindingTimeline({ finding, isOverdue }: { finding: SecurityFinding; isOverdue: boolean }) {
  if (finding.status === 'open' && finding.sla_due_at) {
    return (
      <div className="text-left text-xs sm:text-right">
        <div className="flex items-center gap-1.5 sm:justify-end">
          <Clock
            className={`size-3.5 ${isOverdue ? 'text-red-400' : 'text-yellow-400'}`}
            aria-hidden="true"
          />
          <span className={isOverdue ? 'text-red-400' : 'text-yellow-400'}>
            SLA{' '}
            {isOverdue
              ? `overdue by ${formatDistanceToNow(new Date(finding.sla_due_at))}`
              : `due in ${formatDistanceToNow(new Date(finding.sla_due_at))}`}
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 font-mono tabular-nums">
          {format(new Date(finding.sla_due_at), 'PPP')}
        </div>
      </div>
    );
  }

  if (finding.status === 'fixed' && finding.fixed_at) {
    return (
      <div className="text-left text-xs sm:text-right">
        <div className="flex items-center gap-1.5 text-green-400 sm:justify-end">
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
          Fixed {formatDistanceToNow(new Date(finding.fixed_at), { addSuffix: true })}
        </div>
        <div className="text-muted-foreground mt-0.5 font-mono tabular-nums">
          {format(new Date(finding.fixed_at), 'PPP')}
        </div>
      </div>
    );
  }

  if (finding.status === 'ignored' && finding.ignored_reason) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="break-words">Dismissed: {finding.ignored_reason.replace(/_/g, ' ')}</span>
      </div>
    );
  }

  return null;
}

function FindingDetails({ finding }: { finding: SecurityFinding }) {
  return (
    <TabsContent value="details" className="space-y-6 pt-2">
      <div className="text-foreground flex items-center gap-2 text-sm font-medium">
        <Package className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {finding.package_name} ({finding.package_ecosystem})
        </span>
      </div>

      <div className="bg-muted/40 flex flex-wrap gap-x-6 gap-y-3 rounded-lg border border-border px-4 py-3 text-sm">
        {finding.cve_id && <Metadata label="CVE" value={finding.cve_id} />}
        {finding.ghsa_id && <Metadata label="GHSA" value={finding.ghsa_id} />}
        <Metadata label="Vulnerable" value={finding.vulnerable_version_range || 'Unknown'} />
        <Metadata label="Patched" value={finding.patched_version || 'No patch available'} />
        {finding.manifest_path && <Metadata label="Manifest" value={finding.manifest_path} />}
      </div>

      <div className="min-w-0">
        <h4 className="mb-2 font-medium">Description</h4>
        <MarkdownProse markdown={finding.description ?? ''} />
        {finding.dependabot_html_url && (
          <Button variant="outline" size="sm" asChild className="mt-3">
            <a href={finding.dependabot_html_url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 size-4" aria-hidden="true" />
              View on GitHub
            </a>
          </Button>
        )}
      </div>
    </TabsContent>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="break-all font-mono tabular-nums">{value}</div>
    </div>
  );
}

type AnalysisPanelProps = {
  analysis: FindingAnalysis;
  analysisStatus: string | null;
  analysisError: string | null;
  isAwaitingAnalysisStart: boolean;
  isAnalyzing: boolean;
  onStartAnalysis: StartAnalysis;
};

function FindingTriage({
  analysis,
  analysisStatus,
  analysisError,
  isAwaitingAnalysisStart,
  isAnalyzing,
  onStartAnalysis,
}: AnalysisPanelProps) {
  if (analysis?.triage) {
    return (
      <TabsContent value="triage" className="space-y-4 pt-2">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {analysis.triage.suggestedAction === 'dismiss' && (
              <Badge className="bg-green-500/20 text-green-400 ring-1 ring-green-500/20">
                <CheckCircle2 className="mr-1 size-3" aria-hidden="true" />
                Safe to dismiss
              </Badge>
            )}
            {analysis.triage.suggestedAction === 'analyze_codebase' && (
              <Badge className="bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/20">
                Needs analysis
              </Badge>
            )}
            {analysis.triage.suggestedAction === 'manual_review' && (
              <Badge className="bg-red-500/20 text-red-400 ring-1 ring-red-500/20">
                Manual review
              </Badge>
            )}
            {analysis.triage.confidence && (
              <Badge variant="outline" className="text-muted-foreground">
                {analysis.triage.confidence} confidence
              </Badge>
            )}
          </div>
          {analysis.triage.needsSandboxReasoning && (
            <MarkdownProse
              markdown={analysis.triage.needsSandboxReasoning}
              className="text-muted-foreground text-sm"
            />
          )}
        </div>
      </TabsContent>
    );
  }

  const isLoading =
    isAwaitingAnalysisStart || analysisStatus === 'running' || analysisStatus === 'pending';

  return (
    <TabsContent value="triage" className="space-y-4 pt-2">
      {isLoading ? (
        <LoadingPanel
          message={
            isAwaitingAnalysisStart || analysisStatus === 'pending'
              ? `${securityAgentCommandAdmissionCopy.start_analysis.pendingLabel}…`
              : 'Triage in progress…'
          }
        />
      ) : analysisStatus === 'failed' ? (
        <ErrorPanel
          message={
            analysisError
              ? `Triage failed: ${analysisError}`
              : 'Triage failed. Retry analysis. If it fails again, verify repository access.'
          }
          retryLabel="Retry triage"
          onRetry={() => onStartAnalysis()}
          disabled={isAnalyzing}
        />
      ) : (
        <EmptyPanel text="Run triage to quickly assess if this vulnerability needs attention.">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onStartAnalysis()}
            disabled={isAnalyzing}
          >
            <Zap className="mr-2 size-4" aria-hidden="true" />
            Start triage
          </Button>
        </EmptyPanel>
      )}
    </TabsContent>
  );
}

type FindingAnalysisProps = AnalysisPanelProps & {
  cliSessionId: string | null;
  organizationId?: string;
};

function FindingAnalysis({
  analysis,
  analysisStatus,
  analysisError,
  isAwaitingAnalysisStart,
  isAnalyzing,
  onStartAnalysis,
  cliSessionId,
  organizationId,
}: FindingAnalysisProps) {
  const sessionHref = cliSessionId
    ? organizationId
      ? `/organizations/${organizationId}/cloud/chat?sessionId=${cliSessionId}`
      : `/cloud/chat?sessionId=${cliSessionId}`
    : null;

  let content: React.ReactNode;
  if (analysis?.sandboxAnalysis && analysisStatus === 'completed') {
    const sandboxAnalysis = analysis.sandboxAnalysis;
    const usageLocations = [...new Set(sandboxAnalysis.usageLocations)];
    content = (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {sandboxAnalysis.isExploitable === true && (
            <Badge className="bg-red-500/20 text-red-400 ring-1 ring-red-500/20">
              <XCircle className="mr-1 size-3" aria-hidden="true" />
              Exploitable
            </Badge>
          )}
          {sandboxAnalysis.isExploitable === false && (
            <Badge className="bg-green-500/20 text-green-400 ring-1 ring-green-500/20">
              <CheckCircle2 className="mr-1 size-3" aria-hidden="true" />
              Not exploitable
            </Badge>
          )}
        </div>
        {sandboxAnalysis.summary && (
          <p className="text-muted-foreground text-sm">{sandboxAnalysis.summary}</p>
        )}
        {usageLocations.length > 0 && (
          <div>
            <span className="text-muted-foreground text-xs font-medium">Usage locations:</span>
            <ul className="text-muted-foreground mt-1 list-inside list-disc font-mono text-xs">
              {usageLocations.slice(0, 5).map(location => (
                <li key={location} className="truncate">
                  {location}
                </li>
              ))}
              {usageLocations.length > 5 && (
                <li className="text-muted-foreground/70">…and {usageLocations.length - 5} more</li>
              )}
            </ul>
          </div>
        )}
        {sandboxAnalysis.suggestedFix && (
          <div>
            <span className="text-muted-foreground text-xs font-medium">Suggested fix:</span>
            <p className="text-muted-foreground mt-1 text-xs">{sandboxAnalysis.suggestedFix}</p>
          </div>
        )}
        {sandboxAnalysis.rawMarkdown && (
          <MarkdownProse markdown={sandboxAnalysis.rawMarkdown} className="text-muted-foreground" />
        )}
        {sessionHref && (
          <Link href={sessionHref} className={`${linkClassName} items-center gap-1 text-sm`}>
            <ExternalLink className="size-4" aria-hidden="true" />
            Continue conversation in Cloud Agent
          </Link>
        )}
      </div>
    );
  } else if (analysisStatus === 'completed' && analysis?.rawMarkdown) {
    content = <MarkdownProse markdown={analysis.rawMarkdown} className="text-muted-foreground" />;
  } else if (
    isAwaitingAnalysisStart ||
    analysisStatus === 'running' ||
    analysisStatus === 'pending'
  ) {
    content = (
      <LoadingPanel
        message={
          isAwaitingAnalysisStart || analysisStatus === 'pending'
            ? `${securityAgentCommandAdmissionCopy.start_analysis.pendingLabel}…`
            : 'Codebase analysis in progress…'
        }
        detail="This usually takes 1–2 minutes. The agent is searching your codebase."
      >
        {sessionHref && (
          <Link href={sessionHref} className={`${linkClassName} items-center gap-1 text-xs`}>
            <ExternalLink className="size-3" aria-hidden="true" />
            Watch analysis in Cloud Agent
          </Link>
        )}
      </LoadingPanel>
    );
  } else if (analysisStatus === 'failed') {
    content = (
      <ErrorPanel
        message={
          analysisError
            ? `Codebase analysis failed: ${analysisError}`
            : 'Codebase analysis failed. Retry analysis. If it fails again, verify repository access.'
        }
        retryLabel="Retry analysis"
        onRetry={() => onStartAnalysis({ retrySandboxOnly: Boolean(analysis?.triage) })}
        disabled={isAnalyzing}
      />
    );
  } else if (analysis?.triage?.needsSandboxAnalysis === false) {
    content = (
      <EmptyPanel text="Triage determined codebase analysis is not needed for this finding." />
    );
  } else if (!analysis) {
    content = (
      <EmptyPanel text="Run deep codebase analysis to verify exploitability. Triage runs first.">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onStartAnalysis()}
          disabled={isAnalyzing}
        >
          <Brain className="mr-2 size-4" aria-hidden="true" />
          Start analysis
        </Button>
      </EmptyPanel>
    );
  } else {
    content = (
      <EmptyPanel text="Codebase analysis has not run yet. It starts automatically if triage determines it is needed." />
    );
  }

  return (
    <TabsContent value="analysis" className="space-y-4 pt-2">
      {content}
    </TabsContent>
  );
}

function LoadingPanel({
  message,
  detail,
  children,
}: {
  message: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="block rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-yellow-400">
        <LoadingSpinner />
        <p className="text-sm">{message}</p>
      </div>
      {detail && <p className="text-muted-foreground mt-1 text-xs">{detail}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

function ErrorPanel({
  message,
  retryLabel,
  onRetry,
  disabled,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3" role="alert">
      <p className="text-destructive text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={disabled} className="mt-2">
        {retryLabel}
      </Button>
    </div>
  );
}

function EmptyPanel({ children, text }: { children?: React.ReactNode; text: string }) {
  return (
    <div className={statusPanelClassName}>
      <p className={`text-muted-foreground text-sm ${children ? 'mb-2' : ''}`}>{text}</p>
      {children}
    </div>
  );
}

function FindingFooter({
  finding,
  canDismiss,
  onDismiss,
  onClose,
}: {
  finding: SecurityFinding;
  canDismiss: boolean;
  onDismiss: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mt-6 flex justify-end border-t border-border pt-4">
      <div className="flex flex-wrap items-stretch justify-end gap-2">
        {canDismiss && finding.status === 'open' && (
          <Button variant="outline" size="sm" onClick={onDismiss}>
            <XCircle className="mr-2 size-4" aria-hidden="true" />
            Dismiss finding
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

export function FindingDetailDialog({
  finding,
  open,
  onOpenChange,
  onDismiss,
  canDismiss,
  organizationId,
}: FindingDetailDialogProps) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const { handleStartAnalysis: triggerStartAnalysis, startingAnalysisIds } = useSecurityAgent();
  const isAwaitingAnalysisStart = finding ? startingAnalysisIds.has(finding.id) : false;

  const pollWhileActive = (query: { state: { data?: { status?: string | null } } }) => {
    const status = query.state.data?.status;
    if (isAwaitingAnalysisStart || status === 'pending' || status === 'running') {
      return ANALYSIS_POLL_INTERVAL_MS;
    }
    return false as const;
  };
  const orgAnalysisQuery = useQuery({
    ...trpc.organizations.securityAgent.getAnalysis.queryOptions({
      organizationId: organizationId ?? '',
      findingId: finding?.id ?? '',
    }),
    enabled: open && Boolean(finding) && isOrg,
    refetchInterval: pollWhileActive,
  });
  const personalAnalysisQuery = useQuery({
    ...trpc.securityAgent.getAnalysis.queryOptions({
      findingId: finding?.id ?? '',
    }),
    enabled: open && Boolean(finding) && !isOrg,
    refetchInterval: pollWhileActive,
  });
  const analysisData = isOrg ? orgAnalysisQuery.data : personalAnalysisQuery.data;

  if (!finding) return null;

  const analysisStatus = analysisData?.status ?? finding.analysis_status;
  const analysis = analysisData?.analysis ?? finding.analysis;
  const analysisError = analysisData?.error ?? finding.analysis_error;
  const cliSessionId = analysisData?.cliSessionId ?? finding.cli_session_id;
  const isAnalyzing =
    isAwaitingAnalysisStart || analysisStatus === 'pending' || analysisStatus === 'running';
  const handleStartAnalysis: StartAnalysis = ({ retrySandboxOnly } = {}) => {
    triggerStartAnalysis(finding.id, { retrySandboxOnly });
  };

  const analysisPanelProps = {
    analysis,
    analysisStatus,
    analysisError,
    isAwaitingAnalysisStart,
    isAnalyzing,
    onStartAnalysis: handleStartAnalysis,
  } satisfies AnalysisPanelProps;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-4xl overflow-x-hidden overflow-y-auto p-4 sm:max-h-[90vh] sm:p-6">
        <FindingHeader finding={finding} analysis={analysis} analysisStatus={analysisStatus} />

        <Tabs key={finding.id} defaultValue="details" className="min-w-0">
          <TabsList className="grid w-full grid-cols-3 sm:max-w-md">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="triage" className="flex min-w-0 items-center gap-1.5">
              <AnalysisStatusIcon
                status={analysis?.triage ? 'completed' : analysisStatus}
                fallback={<Zap className="size-3.5" aria-hidden="true" />}
              />
              Triage
            </TabsTrigger>
            <TabsTrigger value="analysis" className="flex min-w-0 items-center gap-1.5">
              <AnalysisStatusIcon
                status={
                  analysis?.sandboxAnalysis && analysisStatus === 'completed'
                    ? 'completed'
                    : analysisStatus
                }
                fallback={<Brain className="size-3.5" aria-hidden="true" />}
              />
              Analysis
            </TabsTrigger>
          </TabsList>

          <FindingDetails finding={finding} />
          <FindingTriage {...analysisPanelProps} />
          <FindingAnalysis
            {...analysisPanelProps}
            cliSessionId={cliSessionId}
            organizationId={organizationId}
          />
          <FindingFooter
            finding={finding}
            canDismiss={canDismiss}
            onDismiss={onDismiss}
            onClose={() => onOpenChange(false)}
          />
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
