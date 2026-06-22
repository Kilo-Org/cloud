'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, AlertTriangle, ArrowRight, Lightbulb, X } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { RecommendationKey } from '@/lib/organizations/recommendations';

export function RecommendationsView({
  organizationId,
  canDismiss,
}: {
  organizationId: string;
  canDismiss: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const recommendationsQueryKey = trpc.organizations.usageDetails.getRecommendations.queryKey({
    organizationId,
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: recommendationsQueryKey });

  const { data, isLoading, isError, refetch } = useQuery(
    trpc.organizations.usageDetails.getRecommendations.queryOptions({ organizationId })
  );

  const restoreMutation = useMutation(
    trpc.organizations.usageDetails.restoreRecommendation.mutationOptions({
      onSuccess: invalidate,
      onError: () => toast.error('Could not restore the suggestion. Try again.'),
    })
  );

  const dismissMutation = useMutation(
    trpc.organizations.usageDetails.dismissRecommendation.mutationOptions({
      onSuccess: (_result, variables) => {
        invalidate();
        toast('Suggestion dismissed', {
          action: {
            label: 'Undo',
            onClick: () =>
              restoreMutation.mutate({
                organizationId,
                recommendationKey: variables.recommendationKey,
              }),
          },
        });
      },
      onError: () => toast.error('Could not dismiss the suggestion. Try again.'),
    })
  );

  if (isLoading) {
    return <RecommendationsSkeleton />;
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle className="text-muted-foreground size-5" />
          <div>
            <p className="font-medium">Recommendations are unavailable</p>
            <p className="text-muted-foreground mt-1 text-sm">Try loading them again.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const recommendations = data?.recommendations ?? [];

  if (recommendations.length === 0) {
    return (
      <Card>
        <CardHeader className="gap-1.5">
          <CardTitle className="text-lg">Recommendations</CardTitle>
          <p className="text-muted-foreground text-sm">
            No recommendations right now. Everything you have configured is in good shape.
          </p>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <div className="flex items-center gap-2">
          <CardTitle className="text-lg">Recommendations</CardTitle>
          <Badge variant="secondary" className="tabular-nums">
            {recommendations.length}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Ways to get more from the features this organization already uses.
        </p>
      </CardHeader>
      <CardContent>
        <div className="divide-border divide-y rounded-lg border">
          {recommendations.map(recommendation => {
            const isAttention = recommendation.severity === 'attention';
            const Icon = isAttention ? AlertTriangle : Lightbulb;
            return (
              <div key={recommendation.key} className="flex items-start gap-3 p-4">
                <div
                  className={
                    isAttention
                      ? 'bg-destructive/10 text-destructive mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md'
                      : 'bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md'
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{recommendation.title}</p>
                  <p className="text-muted-foreground mt-1 text-sm">{recommendation.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={recommendation.actionUrl}>
                      {recommendation.actionLabel}
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                  {canDismiss && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground size-8"
                      aria-label={`Dismiss suggestion: ${recommendation.title}`}
                      disabled={dismissMutation.isPending}
                      onClick={() =>
                        dismissMutation.mutate({
                          organizationId,
                          recommendationKey: recommendation.key as RecommendationKey,
                        })
                      }
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RecommendationsSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
