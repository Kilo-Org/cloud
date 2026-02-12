'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ExternalLink,
  GitPullRequest,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Ban,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { CodeReviewStreamView } from './CodeReviewStreamView';

type Platform = 'github' | 'gitlab';

type CodeReviewJobsCardProps = {
  organizationId?: string;
  platform?: Platform;
};

type CodeReviewStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

const statusConfig: Record<
  CodeReviewStatus,
  {
    icon: React.ComponentType<{ className?: string }>;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    label: string;
  }
> = {
  pending: { icon: Clock, variant: 'secondary', label: 'Pending' },
  queued: { icon: Clock, variant: 'secondary', label: 'Queued' },
  running: { icon: Loader2, variant: 'default', label: 'Running' },
  completed: { icon: CheckCircle2, variant: 'default', label: 'Completed' },
  failed: { icon: XCircle, variant: 'destructive', label: 'Failed' },
  cancelled: { icon: Ban, variant: 'outline', label: 'Cancelled' },
  interrupted: { icon: AlertCircle, variant: 'outline', label: 'Interrupted' },
};

const PAGE_SIZE = 10;

export function CodeReviewJobsCard({
  organizationId,
  platform = 'github',
}: CodeReviewJobsCardProps) {
  const [expandedReviewId, setExpandedReviewId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const offset = (currentPage - 1) * PAGE_SIZE;
  const prLabel = platform === 'gitlab' ? 'merge requests' : 'pull requests';

  // Fetch code reviews with auto-refresh every 5 seconds if there are active jobs
  const { data, isLoading, isFetching } = useQuery({
    ...(organizationId
      ? trpc.codeReviews.listForOrganization.queryOptions({
          organizationId,
          limit: PAGE_SIZE,
          offset,
          platform,
        })
      : trpc.codeReviews.listForUser.queryOptions({
          limit: PAGE_SIZE,
          offset,
          platform,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result || !result.success) return false;
      const reviews = result.reviews || [];
      const hasActiveJobs = reviews.some(r => ['pending', 'queued', 'running'].includes(r.status));
      return hasActiveJobs ? 5000 : false; // Poll every 5s if active jobs
    },
  });

  // Retrigger mutation for failed/cancelled/interrupted reviews
  const retriggerMutation = useMutation(
    trpc.codeReviews.retrigger.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review retriggered', {
          description: 'The code review has been queued for processing.',
        });
        setActionInProgressId(null);
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.codeReviews.listForOrganization.queryKey({
                organizationId,
                limit: PAGE_SIZE,
                offset,
                platform,
              })
            : trpc.codeReviews.listForUser.queryKey({ limit: PAGE_SIZE, offset, platform }),
        });
      },
      onError: error => {
        toast.error('Failed to retrigger code review', {
          description: error.message,
        });
        setActionInProgressId(null);
      },
    })
  );

  // Cancel mutation for pending/queued/running reviews
  const cancelMutation = useMutation(
    trpc.codeReviews.cancel.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review cancelled', {
          description: 'The code review has been cancelled.',
        });
        setActionInProgressId(null);
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: organizationId
            ? trpc.codeReviews.listForOrganization.queryKey({
                organizationId,
                limit: PAGE_SIZE,
                offset,
                platform,
              })
            : trpc.codeReviews.listForUser.queryKey({ limit: PAGE_SIZE, offset, platform }),
        });
      },
      onError: error => {
        toast.error('Failed to cancel code review', {
          description: error.message,
        });
        setActionInProgressId(null);
      },
    })
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Code Review Jobs</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const reviews = data?.success ? data.reviews : [];
  const total = data?.success ? data.total : 0;
  const hasMore = data?.success ? data.hasMore : false;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrevious = currentPage > 1;
  const hasNext = hasMore;

  // Show empty state only on first page with no reviews
  if (reviews.length === 0 && currentPage === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5" />
            Code Review Jobs
          </CardTitle>
          <CardDescription>No code reviews yet</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Code review jobs will appear here when {prLabel} are reviewed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitPullRequest className="h-5 w-5" />
          Code Review Jobs
        </CardTitle>
        <CardDescription>
          {total > 0 ? (
            <>
              Showing {offset + 1}-{Math.min(offset + reviews.length, total)} of {total} code
              reviews
            </>
          ) : (
            'No code reviews'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {reviews.map(review => {
            const statusInfo = statusConfig[review.status as CodeReviewStatus] ?? {
              icon: AlertCircle,
              variant: 'outline' as const,
              label: review.status,
            };
            const StatusIcon = statusInfo.icon;
            const isExpanded = expandedReviewId === review.id;
            const canShowStream =
              review.session_id && ['running', 'queued'].includes(review.status);

            return (
              <div key={review.id} className="space-y-2">
                <div className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-3 transition-colors">
                  {/* Status Icon */}
                  <div className="mt-1">
                    <StatusIcon
                      className={`h-5 w-5 ${review.status === 'running' ? 'animate-spin' : ''} ${
                        review.status === 'completed'
                          ? 'text-green-500'
                          : review.status === 'failed'
                            ? 'text-red-500'
                            : 'text-muted-foreground'
                      }`}
                    />
                  </div>

                  {/* PR Info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <a
                          href={review.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground hover:text-primary inline-flex items-center gap-1 text-sm font-medium transition-colors hover:underline"
                        >
                          {review.pr_title}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                          <span>{review.repo_full_name}</span>
                          <span>•</span>
                          <span>#{review.pr_number}</span>
                          <span>•</span>
                          <span>by @{review.pr_author}</span>
                        </div>
                      </div>

                      {/* Status Badge */}
                      <Badge variant={statusInfo.variant} className="gap-1 whitespace-nowrap">
                        <StatusIcon
                          className={`h-3 w-3 ${review.status === 'running' ? 'animate-spin' : ''}`}
                        />
                        {statusInfo.label}
                      </Badge>
                    </div>

                    {/* Timestamps & Session Link */}
                    <div className="text-muted-foreground flex items-center gap-3 text-xs">
                      {review.started_at && (
                        <span>
                          Started{' '}
                          {formatDistanceToNow(new Date(review.started_at), { addSuffix: true })}
                        </span>
                      )}
                      {review.completed_at && (
                        <span>
                          Completed{' '}
                          {formatDistanceToNow(new Date(review.completed_at), { addSuffix: true })}
                        </span>
                      )}
                      {!review.started_at && (
                        <span>
                          Created{' '}
                          {formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}
                        </span>
                      )}
                    </div>

                    {/* Error Message */}
                    {review.error_message && (
                      <div className="text-destructive mt-1 text-xs">
                        Error: {review.error_message}
                      </div>
                    )}

                    {/* View Progress Button */}
                    {canShowStream && (
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setExpandedReviewId(isExpanded ? null : review.id)}
                          className="gap-2"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="h-3 w-3" />
                              Hide Progress
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3" />
                              View Progress
                            </>
                          )}
                        </Button>
                      </div>
                    )}

                    {/* Action Buttons */}
                    <div className="mt-2 flex gap-2">
                      {/* Cancel Button for pending/queued/running reviews */}
                      {['pending', 'queued', 'running'].includes(review.status) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActionInProgressId(review.id);
                            cancelMutation.mutate({ reviewId: review.id });
                          }}
                          disabled={actionInProgressId === review.id && cancelMutation.isPending}
                          className="gap-2"
                        >
                          <Ban
                            className={`h-3 w-3 ${actionInProgressId === review.id && cancelMutation.isPending ? 'animate-spin' : ''}`}
                          />
                          {actionInProgressId === review.id && cancelMutation.isPending
                            ? 'Cancelling...'
                            : 'Cancel'}
                        </Button>
                      )}

                      {/* Retry Button for failed/cancelled/interrupted reviews */}
                      {['failed', 'cancelled', 'interrupted'].includes(review.status) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActionInProgressId(review.id);
                            retriggerMutation.mutate({ reviewId: review.id });
                          }}
                          disabled={actionInProgressId === review.id && retriggerMutation.isPending}
                          className="gap-2"
                        >
                          <RotateCcw
                            className={`h-3 w-3 ${actionInProgressId === review.id && retriggerMutation.isPending ? 'animate-spin' : ''}`}
                          />
                          {actionInProgressId === review.id && retriggerMutation.isPending
                            ? 'Retrying...'
                            : 'Retry'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Streaming View (Expanded) */}
                {isExpanded && canShowStream && review.session_id && (
                  <CodeReviewStreamView
                    sessionId={review.session_id}
                    reviewId={review.id}
                    onComplete={() => {
                      // Refetch reviews when complete
                      window.location.reload();
                    }}
                  />
                )}
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
