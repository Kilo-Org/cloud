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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

type Severity = 'critical' | 'high' | 'medium' | 'low';

function isSeverity(value: string): value is Severity {
  return ['critical', 'high', 'medium', 'low'].includes(value);
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
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-400" />;
    case 'pending':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-400" />;
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

export function FindingDetailDialog({
  finding,
  open,
  onOpenChange,
  onDismiss,
  canDismiss,
  organizationId,
}: FindingDetailDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isOrg = !!organizationId;

  // Poll for analysis status when running.
  // Two separate queries for org/personal to avoid type-union issues with useQuery.
  const pollWhileActive = (query: { state: { data?: { status?: string | null } } }) => {
    const status = query.state.data?.status;
    if (status === 'pending' || status === 'running') return 3000;
    return false as const;
  };
  const orgAnalysisQuery = useQuery({
    ...trpc.organizations.securityAgent.getAnalysis.queryOptions({
      organizationId: organizationId ?? '',
      findingId: finding?.id ?? '',
    }),
    enabled: open && !!finding && isOrg,
    refetchInterval: pollWhileActive,
  });
  const personalAnalysisQuery = useQuery({
    ...trpc.securityAgent.getAnalysis.queryOptions({
      findingId: finding?.id ?? '',
    }),
    enabled: open && !!finding && !isOrg,
    refetchInterval: pollWhileActive,
  });
  const analysisData = isOrg ? orgAnalysisQuery.data : personalAnalysisQuery.data;

  // Start analysis mutation (organization)
  const startOrgAnalysisMutation = useMutation(
    trpc.organizations.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
      },
    })
  );

  // Start analysis mutation (user)
  const startUserAnalysisMutation = useMutation(
    trpc.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
      },
    })
  );

  const startAnalysisMutation = isOrg ? startOrgAnalysisMutation : startUserAnalysisMutation;

  if (!finding) return null;

  // Use polled data if available, otherwise use finding data
  const analysisStatus = analysisData?.status ?? finding.analysis_status;
  const analysis = analysisData?.analysis ?? finding.analysis;
  const analysisError = analysisData?.error ?? finding.analysis_error;
  const cliSessionId = analysisData?.cliSessionId ?? finding.cli_session_id;

  const isAnalyzing =
    startAnalysisMutation.isPending || analysisStatus === 'pending' || analysisStatus === 'running';

  const handleStartAnalysis = ({ retrySandboxOnly }: { retrySandboxOnly?: boolean } = {}) => {
    if (isOrg) {
      if (!organizationId) return;
      startOrgAnalysisMutation.mutate({
        organizationId,
        findingId: finding.id,
        retrySandboxOnly,
      });
    } else {
      startUserAnalysisMutation.mutate({ findingId: finding.id, retrySandboxOnly });
    }
  };

  const severity: Severity = isSeverity(finding.severity) ? finding.severity : 'medium';
  const isOverdue =
    finding.status === 'open' && finding.sla_due_at && isPast(new Date(finding.sla_due_at));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-x-hidden overflow-y-auto">
        <div className="flex items-start gap-6">
          {/* Left: title, repo, package */}
          <DialogHeader className="min-w-0 flex-1">
            <DialogTitle className="text-xl">{finding.title}</DialogTitle>
            <div className="text-muted-foreground text-sm">
              <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs">
                {finding.repo_full_name}
              </code>
              <div className="mt-1 flex gap-3 text-xs">
                <span>Detected {format(new Date(finding.first_detected_at), 'PPP')}</span>
                <span>Synced {format(new Date(finding.last_synced_at), 'PPP')}</span>
              </div>
            </div>
            <DialogDescription className="sr-only">
              {finding.package_name} ({finding.package_ecosystem})
            </DialogDescription>
          </DialogHeader>

          {/* Right: status badges + SLA */}
          <div className="flex shrink-0 flex-col items-end gap-2 pt-4">
            <div className="flex items-center gap-2">
              <SeverityBadge severity={severity} />
              <FindingStatusBadge status={finding.status} />
              <ExploitabilityBadge analysis={analysis} />
            </div>
            {finding.status === 'open' && finding.sla_due_at && (
              <div className="text-right text-xs">
                <div className="flex items-center justify-end gap-1.5">
                  <Clock
                    className={`h-3.5 w-3.5 ${isOverdue ? 'text-red-400' : 'text-yellow-400'}`}
                  />
                  <span className={isOverdue ? 'text-red-400' : 'text-yellow-400'}>
                    SLA{' '}
                    {isOverdue
                      ? `overdue by ${formatDistanceToNow(new Date(finding.sla_due_at))}`
                      : `due in ${formatDistanceToNow(new Date(finding.sla_due_at))}`}
                  </span>
                </div>
                <div className="text-muted-foreground mt-0.5">
                  {format(new Date(finding.sla_due_at), 'PPP')}
                </div>
              </div>
            )}
            {finding.status === 'fixed' && finding.fixed_at && (
              <div className="text-right text-xs">
                <div className="flex items-center justify-end gap-1.5 text-green-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Fixed {formatDistanceToNow(new Date(finding.fixed_at), { addSuffix: true })}
                </div>
                <div className="text-muted-foreground mt-0.5">
                  {format(new Date(finding.fixed_at), 'PPP')}
                </div>
              </div>
            )}
            {finding.status === 'ignored' && finding.ignored_reason && (
              <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <XCircle className="h-3.5 w-3.5" />
                Dismissed: {finding.ignored_reason.replace(/_/g, ' ')}
              </div>
            )}
          </div>
        </div>

        <Tabs key={finding.id} defaultValue="details" className="min-w-0">
          <TabsList className="grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="triage" className="flex items-center gap-1.5">
              <AnalysisStatusIcon
                status={analysis?.triage ? 'completed' : analysisStatus}
                fallback={<Zap className="h-3.5 w-3.5" />}
              />
              Triage
            </TabsTrigger>
            <TabsTrigger value="analysis" className="flex items-center gap-1.5">
              <AnalysisStatusIcon
                status={
                  analysis?.sandboxAnalysis && analysisStatus === 'completed'
                    ? 'completed'
                    : analysisStatus
                }
                fallback={<Brain className="h-3.5 w-3.5" />}
              />
              Analysis
            </TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="space-y-6 pt-2">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <Package className="h-4 w-4" />
              {finding.package_name} ({finding.package_ecosystem})
            </div>

            {/* Metadata band */}
            <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3 text-sm">
              {finding.cve_id && (
                <div>
                  <div className="text-muted-foreground text-xs">CVE</div>
                  <div className="font-mono">{finding.cve_id}</div>
                </div>
              )}
              {finding.ghsa_id && (
                <div>
                  <div className="text-muted-foreground text-xs">GHSA</div>
                  <div className="font-mono">{finding.ghsa_id}</div>
                </div>
              )}
              <div>
                <div className="text-muted-foreground text-xs">Vulnerable</div>
                <div className="font-mono">{finding.vulnerable_version_range || 'Unknown'}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Patched</div>
                <div className="font-mono">{finding.patched_version || 'No patch available'}</div>
              </div>
              {finding.manifest_path && (
                <div>
                  <div className="text-muted-foreground text-xs">Manifest</div>
                  <div className="font-mono">{finding.manifest_path}</div>
                </div>
              )}
            </div>

            <div className="min-w-0">
              <h4 className="mb-2 font-medium">Description</h4>
              <MarkdownProse markdown={finding.description ?? ''} />
              {finding.dependabot_html_url && (
                <Button variant="outline" size="sm" asChild className="mt-3">
                  <a href={finding.dependabot_html_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View on GitHub
                  </a>
                </Button>
              )}
            </div>
          </TabsContent>

          <TabsContent value="triage" className="space-y-4 pt-2">
            {analysis?.triage ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {analysis.triage.suggestedAction === 'dismiss' && (
                    <Badge
                      variant="outline"
                      className="border-green-500/50 bg-green-500/10 text-green-400"
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Safe to Dismiss
                    </Badge>
                  )}
                  {analysis.triage.suggestedAction === 'analyze_codebase' && (
                    <Badge
                      variant="outline"
                      className="border-yellow-500/50 bg-yellow-500/10 text-yellow-400"
                    >
                      Needs Analysis
                    </Badge>
                  )}
                  {analysis.triage.suggestedAction === 'manual_review' && (
                    <Badge
                      variant="outline"
                      className="border-red-500/50 bg-red-500/10 text-red-400"
                    >
                      Manual Review
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
            ) : analysisStatus === 'running' || analysisStatus === 'pending' ? (
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-yellow-400" />
                  <p className="text-sm text-yellow-400">
                    {analysisStatus === 'pending' ? 'Queued...' : 'Triage in progress...'}
                  </p>
                </div>
              </div>
            ) : analysisStatus === 'failed' ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-400">
                  Triage failed: {analysisError || 'Unknown error'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStartAnalysis()}
                  disabled={isAnalyzing}
                  className="mt-2"
                >
                  Retry
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground mb-2 text-sm">
                  Run triage to quickly assess if this vulnerability needs attention.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStartAnalysis()}
                  disabled={isAnalyzing}
                >
                  <Zap className="mr-2 h-4 w-4" />
                  Start Triage
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="analysis" className="space-y-4 pt-2">
            {analysis?.sandboxAnalysis && analysisStatus === 'completed' ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {analysis.sandboxAnalysis.isExploitable === true && (
                    <Badge
                      variant="outline"
                      className="border-red-500/50 bg-red-500/10 text-red-400"
                    >
                      <XCircle className="mr-1 h-3 w-3" />
                      Exploitable
                    </Badge>
                  )}
                  {analysis.sandboxAnalysis.isExploitable === false && (
                    <Badge
                      variant="outline"
                      className="border-green-500/50 bg-green-500/10 text-green-400"
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Not Exploitable
                    </Badge>
                  )}
                </div>
                {analysis.sandboxAnalysis.summary && (
                  <p className="text-muted-foreground text-sm">
                    {analysis.sandboxAnalysis.summary}
                  </p>
                )}
                {analysis.sandboxAnalysis.usageLocations &&
                  analysis.sandboxAnalysis.usageLocations.length > 0 && (
                    <div>
                      <span className="text-muted-foreground text-xs font-medium">
                        Usage locations:
                      </span>
                      <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
                        {/* usageLocations may contain duplicates, so index is needed for uniqueness */}
                        {analysis.sandboxAnalysis.usageLocations
                          .slice(0, 5)
                          .map((loc: string, i: number) => (
                            <li key={`${loc}-${i}`} className="truncate">
                              {loc}
                            </li>
                          ))}
                        {analysis.sandboxAnalysis.usageLocations.length > 5 && (
                          <li className="text-muted-foreground/70">
                            ...and {analysis.sandboxAnalysis.usageLocations.length - 5} more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                {analysis.sandboxAnalysis.suggestedFix && (
                  <div>
                    <span className="text-muted-foreground text-xs font-medium">
                      Suggested fix:
                    </span>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {analysis.sandboxAnalysis.suggestedFix}
                    </p>
                  </div>
                )}
                {analysis.sandboxAnalysis.rawMarkdown && (
                  <MarkdownProse
                    markdown={analysis.sandboxAnalysis.rawMarkdown}
                    className="text-muted-foreground"
                  />
                )}
                {cliSessionId && (
                  <Link
                    href={
                      organizationId
                        ? `/organizations/${organizationId}/cloud/chat?sessionId=${cliSessionId}`
                        : `/cloud/chat?sessionId=${cliSessionId}`
                    }
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Continue conversation in Cloud Agent
                  </Link>
                )}
              </div>
            ) : analysisStatus === 'completed' && analysis?.rawMarkdown ? (
              // Legacy analysis: completed with top-level rawMarkdown but no sandboxAnalysis
              <div className="space-y-4">
                <MarkdownProse markdown={analysis.rawMarkdown} className="text-muted-foreground" />
              </div>
            ) : analysisStatus === 'running' || analysisStatus === 'pending' ? (
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-yellow-400" />
                  <p className="text-sm text-yellow-400">
                    {analysisStatus === 'pending'
                      ? 'Queued...'
                      : 'Codebase analysis in progress...'}
                  </p>
                </div>
                <p className="text-muted-foreground mt-1 text-xs">
                  This may take 1-2 minutes. The agent is searching your codebase.
                </p>
                {cliSessionId && (
                  <div className="mt-2">
                    <Link
                      href={
                        organizationId
                          ? `/organizations/${organizationId}/cloud/chat?sessionId=${cliSessionId}`
                          : `/cloud/chat?sessionId=${cliSessionId}`
                      }
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Watch analysis in Cloud Agent
                    </Link>
                  </div>
                )}
              </div>
            ) : analysisStatus === 'failed' ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-400">
                  Codebase analysis failed: {analysisError || 'Unknown error'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStartAnalysis({ retrySandboxOnly: !!analysis?.triage })}
                  disabled={isAnalyzing}
                  className="mt-2"
                >
                  Retry Analysis
                </Button>
              </div>
            ) : analysis?.triage?.needsSandboxAnalysis === false ? (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-sm">
                  Triage determined codebase analysis is not needed for this finding.
                </p>
              </div>
            ) : !analysis ? (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground mb-2 text-sm">
                  Deep codebase analysis to verify exploitability. Requires triage to run first.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStartAnalysis()}
                  disabled={isAnalyzing}
                >
                  <Brain className="mr-2 h-4 w-4" />
                  Start Analysis
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-sm">
                  Codebase analysis has not been run yet. It will start automatically if triage
                  determines it is needed.
                </p>
              </div>
            )}
          </TabsContent>

          <div className="mt-6 flex justify-end border-t pt-4">
            <div className="flex items-stretch gap-2">
              {canDismiss && finding.status === 'open' && (
                <Button variant="destructive" size="sm" onClick={onDismiss}>
                  <XCircle className="mr-2 h-4 w-4" />
                  Dismiss
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
