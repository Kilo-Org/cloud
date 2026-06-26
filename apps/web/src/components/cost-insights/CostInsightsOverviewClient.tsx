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

  const {
    data: personalDashboard,
    isLoading: personalDashboardLoading,
    isError: personalDashboardError,
    refetch: refetchPersonalDashboard,
  } = useQuery({
    ...trpc.costInsights.getDashboard.queryOptions(),
    enabled: !organizationId,
  });
  const {
    data: organizationDashboard,
    isLoading: organizationDashboardLoading,
    isError: organizationDashboardError,
    refetch: refetchOrganizationDashboard,
  } = useQuery({
    ...trpc.organizations.costInsights.getDashboard.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });
  const dashboard = organizationId ? organizationDashboard : personalDashboard;
  const dashboardLoading = organizationId ? organizationDashboardLoading : personalDashboardLoading;
  const dashboardError = organizationId ? organizationDashboardError : personalDashboardError;

  const invalidateCostInsights = async () => {
    if (organizationId) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getDashboard.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.getSettings.queryKey({ organizationId }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.costInsights.listEvents.queryKey(),
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
        queryKey: trpc.costInsights.getSettings.queryKey(),
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
  const personalDisableThresholdMutation = useMutation(
    trpc.costInsights.disableThreshold.mutationOptions({
      onSuccess: () => {
        toast.success('Spend threshold turned off');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not turn off spend threshold'),
    })
  );
  const organizationDisableThresholdMutation = useMutation(
    trpc.organizations.costInsights.disableThreshold.mutationOptions({
      onSuccess: () => {
        toast.success('Spend threshold turned off');
        void invalidateCostInsights();
      },
      onError: error => toast.error(error.message || 'Could not turn off spend threshold'),
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

    if (action === 'disable_threshold') {
      if (organizationId) {
        organizationDisableThresholdMutation.mutate({ organizationId });
        return;
      }
      personalDisableThresholdMutation.mutate();
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

  const alertActionsDisabled = organizationId
    ? organizationAcknowledgeMutation.isPending || organizationDisableThresholdMutation.isPending
    : personalAcknowledgeMutation.isPending || personalDisableThresholdMutation.isPending;

  return (
    <CostInsightsDashboardView
      data={dashboard}
      isLoading={dashboardLoading}
      isError={dashboardError}
      activityHref={`${basePath}/activity`}
      alertActionsDisabled={alertActionsDisabled}
      onRetry={() => {
        void (organizationId ? refetchOrganizationDashboard() : refetchPersonalDashboard());
      }}
      onSetupAlerts={() => router.push(`${basePath}/config`)}
      onAlertAction={handleAlertAction}
      onSuggestionDismiss={handleSuggestionDismiss}
      onAskKilo={handleAskKilo}
    />
  );
}
