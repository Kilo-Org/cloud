'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SeverityBadge } from './SeverityBadge';
import { AnalysisStatusBadge } from './AnalysisStatusBadge';
import { AnalysisResultCard } from './AnalysisResultCard';
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
  FileCode,
  GitBranch,
  Brain,
  Loader2,
} from 'lucide-react';
import type { SecurityFinding } from '@/db/schema';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

type Severity = 'critical' | 'high' | 'medium' | 'low';

function isSeverity(value: string): value is Severity {
  return ['critical', 'high', 'medium', 'low'].includes(value);
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

  // Poll for analysis status when running
  const { data: analysisData } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.getAnalysis.queryOptions({
          organizationId: organizationId,
          findingId: finding?.id ?? '',
        })
      : trpc.securityAgent.getAnalysis.queryOptions({
          findingId: finding?.id ?? '',
        })),
    // Enable query whenever dialog is open so we can transition to polling immediately
    // after starting analysis (without depending on the parent `finding` prop updating).
    enabled: open && !!finding,
    refetchInterval: query => {
      const data = query.state.data;
      // Stop polling when completed or failed
      if (data?.status === 'completed' || data?.status === 'failed') {
        return false;
      }
      if (data?.status === 'pending' || data?.status === 'running') {
        return 3000; // Poll every 3 seconds
      }
      return false;
    },
  });

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

  const handleStartAnalysis = () => {
    if (isOrg) {
      startOrgAnalysisMutation.mutate({
        organizationId: organizationId,
        findingId: finding.id,
      });
    } else {
      startUserAnalysisMutation.mutate({ findingId: finding.id });
    }
  };

  const severity: Severity = isSeverity(finding.severity) ? finding.severity : 'medium';
  const isOverdue =
    finding.status === 'open' && finding.sla_due_at && isPast(new Date(finding.sla_due_at));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <SeverityBadge severity={severity} />
            <FindingStatusBadge status={finding.status} />
            <ExploitabilityBadge analysis={analysis} />
          </div>
          <DialogTitle className="text-xl">{finding.title}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <Package className="h-4 w-4" />
            {finding.package_name} ({finding.package_ecosystem})
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap gap-2">
            {finding.cve_id && (
              <Badge variant="secondary" className="font-mono">
                {finding.cve_id}
              </Badge>
            )}
            {finding.ghsa_id && (
              <Badge variant="secondary" className="font-mono">
                {finding.ghsa_id}
              </Badge>
            )}
          </div>

          <div className="min-w-0">
            <h4 className="mb-2 font-medium">Description</h4>
            <MarkdownProse markdown={finding.description ?? ''} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="mb-1 text-sm font-medium">Vulnerable Versions</h4>
              <p className="text-muted-foreground font-mono text-sm">
                {finding.vulnerable_version_range || 'Unknown'}
              </p>
            </div>
            <div>
              <h4 className="mb-1 text-sm font-medium">Patched Version</h4>
              <p className="text-muted-foreground font-mono text-sm">
                {finding.patched_version || 'No patch available'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <h4 className="mb-1 flex items-center gap-1 text-sm font-medium">
                <GitBranch className="h-4 w-4" />
                Repository
              </h4>
              <p className="text-muted-foreground text-sm">{finding.repo_full_name}</p>
            </div>
            <div>
              <h4 className="mb-1 flex items-center gap-1 text-sm font-medium">
                <FileCode className="h-4 w-4" />
                Manifest
              </h4>
              <p className="text-muted-foreground font-mono text-sm">
                {finding.manifest_path || 'Unknown'}
              </p>
            </div>
          </div>

          {finding.status === 'open' && finding.sla_due_at && (
            <div
              className={`rounded-lg border p-3 ${isOverdue ? 'border-red-500/30 bg-red-500/10' : 'border-yellow-500/30 bg-yellow-500/10'}`}
            >
              <div className="flex items-center gap-2">
                <Clock className={`h-4 w-4 ${isOverdue ? 'text-red-400' : 'text-yellow-400'}`} />
                <span
                  className={`text-sm font-medium ${isOverdue ? 'text-red-400' : 'text-yellow-400'}`}
                >
                  {isOverdue
                    ? `SLA overdue by ${formatDistanceToNow(new Date(finding.sla_due_at))}`
                    : `SLA due in ${formatDistanceToNow(new Date(finding.sla_due_at))}`}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                Due: {format(new Date(finding.sla_due_at), 'PPP')}
              </p>
            </div>
          )}

          {finding.status === 'fixed' && finding.fixed_at && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-400" />
                <span className="text-sm font-medium text-green-400">
                  Fixed {formatDistanceToNow(new Date(finding.fixed_at), { addSuffix: true })}
                </span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">
                {format(new Date(finding.fixed_at), 'PPP')}
              </p>
            </div>
          )}

          {finding.status === 'ignored' && finding.ignored_reason && (
            <div className="rounded-lg border border-gray-500/30 bg-gray-500/10 p-3">
              <div className="flex items-center gap-2">
                <XCircle className="text-muted-foreground h-4 w-4" />
                <span className="text-muted-foreground text-sm font-medium">
                  Dismissed: {finding.ignored_reason.replace(/_/g, ' ')}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-2 font-medium">
                <Brain className="h-4 w-4" />
                AI Analysis
              </h4>
              <AnalysisStatusBadge status={analysisStatus} />
            </div>

            {analysis ? (
              <>
                {/* Show analysis card with sandbox reasoning when tier 2 is running */}
                <AnalysisResultCard
                  analysis={analysis}
                  showSandboxReasoning={analysisStatus === 'running'}
                />
                {cliSessionId && (
                  <div className="mt-2">
                    <Link
                      href={
                        organizationId
                          ? `/organizations/${organizationId}/cloud/chat?sessionId=${cliSessionId}`
                          : `/cloud/chat?sessionId=${cliSessionId}`
                      }
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {analysisStatus === 'running'
                        ? 'Watch analysis in Cloud Agent'
                        : 'Continue conversation in Cloud Agent'}
                    </Link>
                  </div>
                )}
              </>
            ) : analysisStatus === 'failed' ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-sm text-red-400">
                  Analysis failed: {analysisError || 'Unknown error'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartAnalysis}
                  disabled={isAnalyzing}
                  className="mt-2"
                >
                  Retry Analysis
                </Button>
              </div>
            ) : analysisStatus === 'running' || analysisStatus === 'pending' ? (
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-yellow-400" />
                  <p className="text-sm text-yellow-400">
                    {analysisStatus === 'pending'
                      ? 'Analysis queued...'
                      : 'Analysis in progress...'}
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
            ) : (
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground mb-2 text-sm">
                  Run AI analysis to determine if this vulnerability is relevant and exploitable in
                  your codebase.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartAnalysis}
                  disabled={isAnalyzing}
                >
                  <Brain className="mr-2 h-4 w-4" />
                  Start Analysis
                </Button>
              </div>
            )}
          </div>

          <div className="text-muted-foreground border-t pt-4 text-xs">
            <div className="flex justify-between">
              <span>First detected: {format(new Date(finding.first_detected_at), 'PPP')}</span>
              <span>Last synced: {format(new Date(finding.last_synced_at), 'PPP')}</span>
            </div>
          </div>

          <div className="flex justify-between border-t pt-4">
            <div className="flex gap-2">
              {finding.dependabot_html_url && (
                <Button variant="outline" size="sm" asChild>
                  <a href={finding.dependabot_html_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    View on GitHub
                  </a>
                </Button>
              )}
            </div>
            <div className="flex gap-2">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
