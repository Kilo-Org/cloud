'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Cable,
  Check,
  Circle,
  Cloud,
  Rocket,
  Shield,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import type { FeatureAdoptionKey } from '@/lib/organizations/feature-adoption';

const featureIcons: Record<FeatureAdoptionKey, typeof Bot> = {
  'source-control-integration': Cable,
  'code-reviewer': Bot,
  'security-agent': Shield,
  'team-integration': Cable,
  'cloud-agent-used': Cloud,
  'project-deployed': Rocket,
};

export function FeatureAdoptionView({
  organizationId,
  compact = false,
  onViewDetails,
}: {
  organizationId: string;
  compact?: boolean;
  onViewDetails?: () => void;
}) {
  const trpc = useTRPC();
  const { data, isLoading, isError, refetch } = useQuery(
    trpc.organizations.usageDetails.getFeatureAdoption.queryOptions({ organizationId })
  );

  if (isLoading) {
    return <FeatureAdoptionSkeleton compact={compact} />;
  }

  if (isError) {
    return (
      <Card className="h-full">
        <CardContent className="flex h-full min-h-56 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle className="text-muted-foreground size-5" />
          <div>
            <p className="font-medium">Feature adoption is unavailable</p>
            <p className="text-muted-foreground mt-1 text-sm">Try loading the report again.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const checks = data?.checks ?? [];
  const adoptedCount = checks.filter(check => check.adopted).length;
  const adoptionPercent =
    checks.length === 0 ? 0 : Math.round((adoptedCount / checks.length) * 100);
  const visibleChecks = compact
    ? [...checks].sort((a, b) => Number(a.adopted) - Number(b.adopted)).slice(0, 3)
    : checks;

  return (
    <Card className="h-full">
      <CardHeader className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <CardTitle className="text-lg">Feature adoption</CardTitle>
              <Badge variant="secondary">Enterprise</Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              See which organization features are configured or have been used.
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums">
              {adoptedCount}/{checks.length}
            </div>
            <div className="text-muted-foreground text-xs">features adopted</div>
          </div>
        </div>
        <Progress
          value={adoptionPercent}
          indicatorClassName="bg-gradient-to-r from-blue-600 via-blue-500 to-green-500"
          aria-label={`${adoptionPercent}% of features adopted`}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="divide-border divide-y rounded-lg border">
          {visibleChecks.map(check => {
            const FeatureIcon = featureIcons[check.key];
            return (
              <div key={check.key} className="flex items-start gap-3 p-4">
                <div
                  className={
                    check.adopted
                      ? 'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-green-500/10 text-green-700 dark:text-green-400'
                      : 'bg-muted text-muted-foreground mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md'
                  }
                >
                  <FeatureIcon className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{check.title}</p>
                  <p className="text-muted-foreground mt-1 text-sm">{check.description}</p>
                </div>
                <div className={compact ? 'mt-0.5 w-28 shrink-0' : 'mt-0.5 w-32 shrink-0'}>
                  <Badge variant={check.adopted ? 'new' : 'outline'} className="gap-1 px-1.5 py-0">
                    {check.adopted ? (
                      <Check className="size-3" aria-hidden="true" />
                    ) : (
                      <Circle className="size-2.5" aria-hidden="true" />
                    )}
                    {check.adopted ? check.adoptedLabel : check.notAdoptedLabel}
                  </Badge>
                </div>
                {!compact && (
                  <div className="flex w-44 shrink-0 justify-end">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={check.actionUrl}>{check.actionLabel}</Link>
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {compact && (
          <Button variant="secondary" size="sm" onClick={onViewDetails}>
            View feature adoption
            <ArrowRight className="size-4" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function FeatureAdoptionSkeleton({ compact }: { compact: boolean }) {
  return (
    <Card className="h-full">
      <CardHeader className="space-y-3">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <Skeleton className="h-2 w-full" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: compact ? 3 : 5 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
