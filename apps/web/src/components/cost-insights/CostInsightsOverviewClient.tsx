'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsDashboardView } from './overview/CostInsightsDashboardView';
import type { DashboardAlert, DashboardAlertAction } from './types';

type CostInsightsOverviewClientProps = {
  organizationId?: string;
  basePath: string;
};

export function CostInsightsOverviewClient({
  organizationId,
  basePath,
}: CostInsightsOverviewClientProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();

  const personalDashboardQuery = useQuery({
    ...trpc.costInsights.getDashboard.queryOptions(),
    enabled: !organizationId,
  });
  const organizationDashboardQuery = useQuery({
    ...trpc.organizations.costInsights.getDashboard.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });
  const dashboardQuery = organizationId ? organizationDashboardQuery : personalDashboardQuery;

  const invalidateCostInsights = async () => {
    if (organizationId) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getDashboard.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.listEvents.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getAttentionState.queryKey({
            organizationId,
          }),
        }),
      ]);
      return;
    }

    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.getDashboard.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.listEvents.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.costInsights.getAttentionState.queryKey(),
      }),
    ]);
  };

  const personalAcknowledgeMutation = useMutation(
    trpc.costInsights.acknowledgeAlert.mutationOptions({
      onSuccess: () => {
        toast.success('Alert marked reviewed');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not mark alert reviewed'),
    })
  );
  const organizationAcknowledgeMutation = useMutation(
    trpc.organizations.costInsights.acknowledgeAlert.mutationOptions({
      onSuccess: () => {
        toast.success('Alert marked reviewed');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not mark alert reviewed'),
    })
  );
  const personalDismissMutation = useMutation(
    trpc.costInsights.dismissSuggestion.mutationOptions({
      onSuccess: () => {
        toast.success('Suggestion dismissed');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not dismiss suggestion'),
    })
  );
  const organizationDismissMutation = useMutation(
    trpc.organizations.costInsights.dismissSuggestion.mutationOptions({
      onSuccess: () => {
        toast.success('Suggestion dismissed');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not dismiss suggestion'),
    })
  );

  const handleAlertAction = (alert: DashboardAlert, action: DashboardAlertAction) => {
    if (action === 'acknowledge') {
      if (organizationId) {
        organizationAcknowledgeMutation.mutate({ organizationId, alertKind: alert.type });
        return;
      }
      personalAcknowledgeMutation.mutate({ alertKind: alert.type });
      return;
    }

    if (action === 'view_spend') {
      document.getElementById('spend-summary-title')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      return;
    }

    router.push(`${basePath}/config`);
  };

  const handleSuggestionDismiss = (suggestionId: string) => {
    if (organizationId) {
      organizationDismissMutation.mutate({ organizationId, suggestionId });
      return;
    }
    personalDismissMutation.mutate({ suggestionId });
  };

  const handleAskKilo = (question: string) => {
    const searchParams = new URLSearchParams({ question });
    router.push(`${basePath}/ask-kilo?${searchParams.toString()}`);
  };

  return (
    <CostInsightsDashboardView
      data={dashboardQuery.data}
      isLoading={dashboardQuery.isLoading}
      isError={dashboardQuery.isError}
      onSetupAlerts={() => router.push(`${basePath}/config`)}
      onAlertAction={handleAlertAction}
      onSuggestionDismiss={handleSuggestionDismiss}
      onAskKilo={handleAskKilo}
    />
  );
}
