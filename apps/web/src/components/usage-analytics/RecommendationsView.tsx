'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, Building, Check, X } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type {
  Recommendation,
  RecommendationKey,
  RecommendationStatus,
} from '@/lib/organizations/recommendations';
import { featureIcons } from './FeatureAdoptionView';
import { StatusDonutChart } from './StatusDonutChart';

type Pane = RecommendationStatus;

const PANES: Array<{ key: Pane; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'completed', label: 'Completed' },
  { key: 'dismissed', label: 'Dismissed' },
];

const EMPTY_COPY: Record<Pane, string> = {
  open: 'No open recommendations. You are all caught up.',
  completed: 'Nothing completed yet. Acting on an open recommendation moves it here.',
  dismissed: 'No dismissed recommendations.',
};

const FEATURE_LABELS: Record<Recommendation['feature'], string> = {
  organization: 'Organization',
  'source-control-integration': 'Source control',
  'code-reviewer': 'Code Reviewer',
  'security-agent': 'Security Agent',
  'team-integration': 'Team integrations',
  'cloud-agent-used': 'Cloud Agent',
  'project-deployed': 'Deploy',
};

function FeatureIcon({ recommendation }: { recommendation: Recommendation }) {
  const Icon =
    recommendation.feature === 'organization' ? Building : featureIcons[recommendation.feature];
  return <Icon className="size-4" aria-hidden="true" />;
}

export function RecommendationsView({
  organizationId,
  canDismiss,
}: {
  organizationId: string;
  canDismiss: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pane, setPane] = useState<Pane>('open');

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
  const byStatus: Record<Pane, Recommendation[]> = {
    open: recommendations.filter(r => r.status === 'open'),
    completed: recommendations.filter(r => r.status === 'completed'),
    dismissed: recommendations.filter(r => r.status === 'dismissed'),
  };
  const visible = byStatus[pane];

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="space-y-1.5">
          <CardTitle className="text-lg">Recommendations</CardTitle>
          <p className="text-muted-foreground text-sm">
            Ways to get more from the features this organization already uses.
          </p>
        </div>
        <nav
          className="bg-muted flex w-full gap-1 overflow-x-auto rounded-lg p-1 sm:w-fit"
          aria-label="Recommendation status"
        >
          {PANES.map(option => (
            <Button
              key={option.key}
              type="button"
              variant="ghost"
              size="sm"
              aria-current={pane === option.key ? 'page' : undefined}
              className={cn(pane === option.key && 'bg-background text-foreground shadow-sm')}
              onClick={() => setPane(option.key)}
            >
              {option.label}
              <span className="text-muted-foreground ml-1.5 tabular-nums">
                {byStatus[option.key].length}
              </span>
            </Button>
          ))}
        </nav>
      </CardHeader>
      <CardContent className="space-y-6">
        <StatusDonutChart
          totalLabel={`${byStatus.open.length} open, ${byStatus.completed.length} completed, and ${byStatus.dismissed.length} dismissed recommendations`}
          data={[
            { label: 'Open', value: byStatus.open.length, color: 'var(--status-warning-icon)' },
            {
              label: 'Completed',
              value: byStatus.completed.length,
              color: 'var(--status-success-icon)',
            },
            {
              label: 'Dismissed',
              value: byStatus.dismissed.length,
              color: 'var(--status-neutral-icon)',
            },
          ]}
        />
        {visible.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            {EMPTY_COPY[pane]}
          </p>
        ) : (
          <TooltipProvider delayDuration={200}>
            <div className="divide-border divide-y rounded-lg border">
              {visible.map(recommendation => (
                <div key={recommendation.key} className="flex items-start gap-3 p-4">
                  <div
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md',
                      recommendation.status === 'completed'
                        ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                        : recommendation.severity === 'attention' &&
                            recommendation.status === 'open'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {recommendation.status === 'completed' ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <FeatureIcon recommendation={recommendation} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground type-eyebrow mb-1">
                      {FEATURE_LABELS[recommendation.feature]}
                    </p>
                    <p
                      className={cn(
                        'text-sm font-medium',
                        recommendation.status !== 'open' && 'text-muted-foreground'
                      )}
                    >
                      {recommendation.title}
                    </p>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {recommendation.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {recommendation.status === 'open' && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={recommendation.actionUrl}>
                          {recommendation.actionLabel}
                          <ArrowRight className="size-4" />
                        </Link>
                      </Button>
                    )}
                    {recommendation.status === 'open' && canDismiss && (
                      <Tooltip>
                        <TooltipTrigger asChild>
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
                        </TooltipTrigger>
                        <TooltipContent>Dismiss. Stop showing this suggestion.</TooltipContent>
                      </Tooltip>
                    )}
                    {recommendation.status === 'dismissed' && canDismiss && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={restoreMutation.isPending}
                        onClick={() =>
                          restoreMutation.mutate({
                            organizationId,
                            recommendationKey: recommendation.key as RecommendationKey,
                          })
                        }
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </TooltipProvider>
        )}
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
        <Skeleton className="h-9 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
