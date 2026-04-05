'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageContainer } from '@/components/layouts/PageContainer';
import { CodeReviewStreamView } from '@/components/code-reviews/CodeReviewStreamView';
import {
  ExternalLink,
  GitPullRequest,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ArrowLeft,
  RotateCcw,
  Ban,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import { TRPCClientError } from '@trpc/client';
import { toast } from 'sonner';
import Link from 'next/link';
import { notFound } from 'next/navigation';

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

type CodeReviewDetailClientProps = {
  reviewId: string;
};

export function CodeReviewDetailClient({ reviewId }: CodeReviewDetailClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    ...trpc.codeReviews.get.queryOptions({ reviewId }),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result?.success) return false;
      const status = result.review.status;
      return ['pending', 'queued', 'running'].includes(status) ? 5000 : false;
    },
  });

  const retriggerMutation = useMutation(
    trpc.codeReviews.retrigger.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review retriggered', {
          description: 'The code review has been queued for processing.',
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.codeReviews.get.queryKey({ reviewId }),
        });
      },
      onError: err => {
        toast.error('Failed to retrigger code review', { description: err.message });
      },
    })
  );

  const cancelMutation = useMutation(
    trpc.codeReviews.cancel.mutationOptions({
      onSuccess: async () => {
        toast.success('Code review cancelled');
        await queryClient.invalidateQueries({
          queryKey: trpc.codeReviews.get.queryKey({ reviewId }),
        });
      },
      onError: err => {
        toast.error('Failed to cancel code review', { description: err.message });
      },
    })
  );

  if (isLoading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      </PageContainer>
    );
  }

  if (error || !data?.success) {
    if (error instanceof TRPCClientError && error.data?.code === 'NOT_FOUND') {
      return notFound();
    }
    return (
      <PageContainer>
        <div className="py-20 text-center">
          <h2 className="text-xl font-semibold">Code review not found</h2>
          <p className="text-muted-foreground mt-2">
            This code review may have been deleted or you don&apos;t have access to it.
          </p>
          <Link href="/code-reviews" className="mt-4 inline-block">
            <Button variant="outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Code Reviews
            </Button>
          </Link>
        </div>
      </PageContainer>
    );
  }

  const review = data.review;
  const status = review.status as CodeReviewStatus;
  const statusInfo = statusConfig[status] ?? {
    icon: AlertCircle,
    variant: 'outline' as const,
    label: review.status,
  };
  const StatusIcon = statusInfo.icon;
  const showStreamView = status !== 'pending';
  const canRetry = ['failed', 'cancelled', 'interrupted'].includes(status);
  const canCancel = ['pending', 'queued', 'running'].includes(status);
  const prLabel = review.platform === 'gitlab' ? 'MR' : 'PR';

  return (
    <PageContainer>
      {/* Back link */}
      <Link
        href="/code-reviews"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Code Reviews
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-3">
            <GitPullRequest className="text-muted-foreground h-6 w-6 shrink-0" />
            <h1 className="text-2xl font-bold">{review.pr_title}</h1>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
            <span>{review.repo_full_name}</span>
            <span>&middot;</span>
            <a
              href={review.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
            >
              {prLabel} #{review.pr_number}
              <ExternalLink className="h-3 w-3" />
            </a>
            <span>&middot;</span>
            <span>by @{review.pr_author}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {review.agent_version && (
            <Badge variant="outline" className="mt-1 text-xs whitespace-nowrap">
              {review.agent_version}
            </Badge>
          )}
          <Badge variant={statusInfo.variant} className="mt-1 gap-1.5 text-sm whitespace-nowrap">
            <StatusIcon className={`h-4 w-4 ${status === 'running' ? 'animate-spin' : ''}`} />
            {statusInfo.label}
          </Badge>
        </div>
      </div>

      {/* Details card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="font-medium">
                {review.head_ref} &rarr; {review.base_ref}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="font-mono text-xs">{review.head_sha.slice(0, 12)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Platform</dt>
              <dd className="capitalize">{review.platform}</dd>
            </div>
            {review.model && (
              <div>
                <dt className="text-muted-foreground">Model</dt>
                <dd>{review.model}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd>
                {format(new Date(review.created_at), 'MMM d, yyyy HH:mm:ss')}
                <span className="text-muted-foreground ml-1 text-xs">
                  ({formatDistanceToNow(new Date(review.created_at), { addSuffix: true })})
                </span>
              </dd>
            </div>
            {review.started_at && (
              <div>
                <dt className="text-muted-foreground">Started</dt>
                <dd>
                  {format(new Date(review.started_at), 'MMM d, yyyy HH:mm:ss')}
                  <span className="text-muted-foreground ml-1 text-xs">
                    ({formatDistanceToNow(new Date(review.started_at), { addSuffix: true })})
                  </span>
                </dd>
              </div>
            )}
            {review.completed_at && (
              <div>
                <dt className="text-muted-foreground">Completed</dt>
                <dd>
                  {format(new Date(review.completed_at), 'MMM d, yyyy HH:mm:ss')}
                  <span className="text-muted-foreground ml-1 text-xs">
                    ({formatDistanceToNow(new Date(review.completed_at), { addSuffix: true })})
                  </span>
                </dd>
              </div>
            )}
            {review.total_cost_musd != null && review.total_cost_musd > 0 && (
              <div>
                <dt className="text-muted-foreground">Cost</dt>
                <dd>${(review.total_cost_musd / 1_000_000).toFixed(4)}</dd>
              </div>
            )}
            {(review.total_tokens_in != null || review.total_tokens_out != null) && (
              <div>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd>
                  {review.total_tokens_in?.toLocaleString() ?? '—'} in /{' '}
                  {review.total_tokens_out?.toLocaleString() ?? '—'} out
                </dd>
              </div>
            )}
          </dl>

          {/* Error message */}
          {review.error_message && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <strong>Error:</strong> {review.error_message}
            </div>
          )}

          {/* Action buttons */}
          {(canCancel || canRetry) && (
            <div className="mt-4 flex gap-2">
              {canCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancelMutation.mutate({ reviewId })}
                  disabled={cancelMutation.isPending}
                  className="gap-2"
                >
                  <Ban className={`h-3 w-3 ${cancelMutation.isPending ? 'animate-spin' : ''}`} />
                  {cancelMutation.isPending ? 'Cancelling...' : 'Cancel'}
                </Button>
              )}
              {canRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => retriggerMutation.mutate({ reviewId })}
                  disabled={retriggerMutation.isPending}
                  className="gap-2"
                >
                  <RotateCcw
                    className={`h-3 w-3 ${retriggerMutation.isPending ? 'animate-spin' : ''}`}
                  />
                  {retriggerMutation.isPending ? 'Retrying...' : 'Retry'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session log / live stream */}
      {showStreamView && (
        <CodeReviewStreamView
          reviewId={reviewId}
          onComplete={() => {
            void queryClient.invalidateQueries({
              queryKey: trpc.codeReviews.get.queryKey({ reviewId }),
            });
          }}
        />
      )}
    </PageContainer>
  );
}
