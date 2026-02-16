'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Brain,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Package,
  ExternalLink,
} from 'lucide-react';
import Link from 'next/link';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { SeverityBadge } from './SeverityBadge';
import type { SecurityFindingAnalysis } from '@/lib/security-agent/core/types';

type AnalysisJobsCardProps = {
  organizationId?: string;
  onGitHubError?: (error: string | null) => void;
};

type AnalysisStatus = 'pending' | 'running' | 'completed' | 'failed';

const statusConfig: Record<
  AnalysisStatus,
  {
    icon: React.ComponentType<{ className?: string }>;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    label: string;
  }
> = {
  pending: { icon: Clock, variant: 'secondary', label: 'Queued' },
  running: { icon: Loader2, variant: 'default', label: 'Analyzing' },
  completed: { icon: CheckCircle2, variant: 'default', label: 'Completed' },
  failed: { icon: XCircle, variant: 'destructive', label: 'Failed' },
};

const PAGE_SIZE = 10;

type AnalysisJob = {
  id: string;
  package_name: string;
  severity: string;
  repo_full_name: string;
  title: string;
  analysis_status: string | null;
  analysis_started_at: Date | null;
  analysis_completed_at: Date | null;
  analysis_error: string | null;
  analysis: SecurityFindingAnalysis | null;
  session_id: string | null;
  cli_session_id: string | null;
};

// Helper to detect GitHub integration errors from error messages
function isGitHubIntegrationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('GitHub token') ||
    message.includes('GitHub installation') ||
    message.includes('installation_id') ||
    message.includes('Bad credentials') ||
    message.includes('Not Found') // GitHub API returns 404 for uninstalled apps
  );
}

export function AnalysisJobsCard({ organizationId, onGitHubError }: AnalysisJobsCardProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [startingAnalysisId, setStartingAnalysisId] = useState<string | null>(null);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isOrg = !!organizationId;
  const offset = (currentPage - 1) * PAGE_SIZE;

  // Fetch findings with analysis status (pending, running, completed, failed)
  const { data, isLoading, isFetching } = useQuery({
    ...(isOrg
      ? trpc.organizations.securityAgent.listAnalysisJobs.queryOptions({
          organizationId,
          limit: PAGE_SIZE,
          offset,
        })
      : trpc.securityAgent.listAnalysisJobs.queryOptions({
          limit: PAGE_SIZE,
          offset,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result) return false;
      const jobs = (result.jobs || []) as AnalysisJob[];
      const hasActiveJobs = jobs.some(j =>
        ['pending', 'running'].includes(j.analysis_status || '')
      );
      return hasActiveJobs ? 5000 : false; // Poll every 5s if active jobs
    },
  });

  // Retry mutation for failed analyses (organization)
  const retryOrgMutation = useMutation(
    trpc.organizations.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async () => {
        onGitHubError?.(null); // Clear any previous error on success
        await queryClient.invalidateQueries();
        setStartingAnalysisId(null);
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          onGitHubError?.(message); // Set error at page level
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Analysis Failed', {
            description: message,
            duration: 8000, // 8 seconds for errors
          });
        }
        setStartingAnalysisId(null);
      },
    })
  );

  // Retry mutation for failed analyses (user)
  const retryUserMutation = useMutation(
    trpc.securityAgent.startAnalysis.mutationOptions({
      onSuccess: async () => {
        onGitHubError?.(null); // Clear any previous error on success
        await queryClient.invalidateQueries();
        setStartingAnalysisId(null);
      },
      onError: error => {
        const message = error instanceof Error ? error.message : String(error);
        if (isGitHubIntegrationError(error)) {
          onGitHubError?.(message); // Set error at page level
          toast.error('GitHub Integration Error', {
            description:
              'The GitHub App may have been uninstalled. Please check your integrations.',
          });
        } else {
          toast.error('Analysis Failed', {
            description: message,
            duration: 8000, // 8 seconds for errors
          });
        }
        setStartingAnalysisId(null);
      },
    })
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Analysis Jobs</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const jobs = (data?.jobs || []) as AnalysisJob[];
  const total = data?.total || 0;
  const runningCount = data?.runningCount || 0;
  const concurrencyLimit = data?.concurrencyLimit || 3;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrevious = currentPage > 1;
  const hasNext = currentPage < totalPages;

  if (jobs.length === 0 && currentPage === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Analysis Jobs
          </CardTitle>
          <CardDescription>No analysis jobs yet</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Analysis jobs will appear here when you analyze security findings. Click &quot;Start
            Analysis&quot; on any finding to begin.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Analysis Jobs
            </CardTitle>
            <CardDescription>
              {total > 0 ? (
                <>
                  Showing {offset + 1}-{Math.min(offset + jobs.length, total)} of {total} jobs
                </>
              ) : (
                'No analysis jobs'
              )}
            </CardDescription>
          </div>
          {/* Concurrency indicator */}
          <Badge variant={runningCount >= concurrencyLimit ? 'destructive' : 'secondary'}>
            {runningCount}/{concurrencyLimit} running
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {jobs.map(job => {
            const status = job.analysis_status as AnalysisStatus | null;
            const statusInfo = status ? statusConfig[status] : null;
            const StatusIcon = statusInfo?.icon || AlertCircle;

            return (
              <div
                key={job.id}
                className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-3 transition-colors"
              >
                {/* Status Icon */}
                <div className="mt-1">
                  <StatusIcon
                    className={`h-5 w-5 ${status === 'running' ? 'animate-spin' : ''} ${
                      status === 'completed'
                        ? 'text-green-500'
                        : status === 'failed'
                          ? 'text-red-500'
                          : 'text-muted-foreground'
                    }`}
                  />
                </div>

                {/* Job Info */}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Package className="text-muted-foreground h-4 w-4" />
                        <span className="font-medium">{job.package_name}</span>
                        <SeverityBadge
                          severity={job.severity as 'critical' | 'high' | 'medium' | 'low'}
                        />
                      </div>
                      <div className="text-muted-foreground mt-0.5 text-xs">
                        {job.repo_full_name} • {job.title}
                      </div>
                    </div>

                    {/* Status Badge */}
                    {statusInfo && (
                      <Badge variant={statusInfo.variant} className="gap-1 whitespace-nowrap">
                        <StatusIcon
                          className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''}`}
                        />
                        {statusInfo.label}
                      </Badge>
                    )}
                  </div>

                  {/* Timestamps */}
                  <div className="text-muted-foreground flex items-center gap-3 text-xs">
                    {job.analysis_started_at && (
                      <span>
                        Started{' '}
                        {formatDistanceToNow(new Date(job.analysis_started_at), {
                          addSuffix: true,
                        })}
                      </span>
                    )}
                    {/* Only show completed_at when status is completed or failed */}
                    {job.analysis_completed_at &&
                      (status === 'completed' || status === 'failed') && (
                        <span>
                          Completed{' '}
                          {formatDistanceToNow(new Date(job.analysis_completed_at), {
                            addSuffix: true,
                          })}
                        </span>
                      )}
                  </div>

                  {/* Cloud Agent Session Link */}
                  {job.cli_session_id && (
                    <div className="mt-1">
                      <Link
                        href={
                          organizationId
                            ? `/organizations/${organizationId}/cloud/chat?sessionId=${job.cli_session_id}`
                            : `/cloud/chat?sessionId=${job.cli_session_id}`
                        }
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View agent session
                      </Link>
                    </div>
                  )}

                  {/* Error Message */}
                  {job.analysis_error && (
                    <div className="text-destructive mt-1 text-xs">Error: {job.analysis_error}</div>
                  )}

                  {/* Analysis Result Summary with Re-run button */}
                  {status === 'completed' && job.analysis && (
                    <div className="mt-2 flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="bg-green-500/20 text-green-400">
                        Analysis Complete
                      </Badge>
                      <span className="text-muted-foreground">
                        View finding details for full analysis
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setStartingAnalysisId(job.id);
                          if (isOrg) {
                            retryOrgMutation.mutate({
                              organizationId: organizationId,
                              findingId: job.id,
                            });
                          } else {
                            retryUserMutation.mutate({ findingId: job.id });
                          }
                        }}
                        disabled={startingAnalysisId === job.id || runningCount >= concurrencyLimit}
                        className="ml-auto gap-1"
                      >
                        <RotateCcw
                          className={`h-3 w-3 ${startingAnalysisId === job.id ? 'animate-spin' : ''}`}
                        />
                        {startingAnalysisId === job.id ? 'Starting...' : 'Re-run Analysis'}
                      </Button>
                    </div>
                  )}

                  {/* Retry Button for Failed */}
                  {status === 'failed' && (
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setStartingAnalysisId(job.id);
                          if (isOrg) {
                            retryOrgMutation.mutate({
                              organizationId: organizationId,
                              findingId: job.id,
                            });
                          } else {
                            retryUserMutation.mutate({ findingId: job.id });
                          }
                        }}
                        disabled={startingAnalysisId === job.id || runningCount >= concurrencyLimit}
                        className="gap-2"
                      >
                        <RotateCcw
                          className={`h-3 w-3 ${startingAnalysisId === job.id ? 'animate-spin' : ''}`}
                        />
                        {startingAnalysisId === job.id ? 'Starting...' : 'Retry'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination Controls */}
        {total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <div className="text-muted-foreground text-sm">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={!hasPrevious || isFetching}
                className="flex items-center gap-1"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => p + 1)}
                disabled={!hasNext || isFetching}
                className="flex items-center gap-1"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
