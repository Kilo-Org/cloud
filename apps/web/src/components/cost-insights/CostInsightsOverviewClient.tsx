'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsDashboardView } from './overview/CostInsightsDashboardView';
import type { CostSuggestion, DashboardAlert, DashboardAlertAction, SpendRange } from './types';
import { useCostInsightsTracking } from './useCostInsightsTracking';

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
  const { trackSuggestionCta, trackUiInteraction } = useCostInsightsTracking(organizationId);
  const trackedDashboardOwner = useRef<string | undefined>(undefined);

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

  useEffect(() => {
    if (!dashboard) return;
    const ownerKey = organizationId ?? 'personal';
    if (trackedDashboardOwner.current === ownerKey) return;
    trackedDashboardOwner.current = ownerKey;
    trackUiInteraction({
      interaction: 'dashboard_viewed',
      spendAlertsEnabled: dashboard.enabled,
      hasActiveAlert: dashboard.alerts.length > 0,
      hasActiveSuggestion: dashboard.suggestions.length > 0,
    });
  }, [dashboard, organizationId, trackUiInteraction]);

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
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Alert marked reviewed');
      },
      onError: error => toast.error(error.message || 'Could not mark alert reviewed'),
    })
  );
  const organizationAcknowledgeMutation = useMutation(
    trpc.organizations.costInsights.acknowledgeAlert.mutationOptions({
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Alert marked reviewed');
      },
      onError: error => toast.error(error.message || 'Could not mark alert reviewed'),
    })
  );
  const personalDismissMutation = useMutation(
    trpc.costInsights.dismissSuggestion.mutationOptions({
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Suggestion dismissed');
      },
      onError: error => toast.error(error.message || 'Could not dismiss suggestion'),
    })
  );
  const organizationDismissMutation = useMutation(
    trpc.organizations.costInsights.dismissSuggestion.mutationOptions({
      onSuccess: async () => {
        await invalidateCostInsights();
        toast.success('Suggestion dismissed');
      },
      onError: error => toast.error(error.message || 'Could not dismiss suggestion'),
    })
  );

  const handleAlertAction = (alert: DashboardAlert, action: DashboardAlertAction) => {
    if (action === 'acknowledge') {
      const acknowledgement = { alertKind: alert.type, eventId: alert.eventId };
      if (organizationId) {
        organizationAcknowledgeMutation.mutate({
          organizationId,
          ...acknowledgement,
        });
        return;
      }
      personalAcknowledgeMutation.mutate(acknowledgement);
      return;
    }

    if (action === 'view_spend') return;
    trackUiInteraction({ interaction: 'alert_settings_clicked', action });
    if (action === 'manage_threshold') {
      const thresholdAnchor =
        alert.type === 'threshold_30d'
          ? 'spend-threshold-30d'
          : alert.type === 'threshold_7d'
            ? 'spend-threshold-7d'
            : 'spend-threshold-24h';
      router.push(`${basePath}/config#${thresholdAnchor}`);
      return;
    }

    router.push(`${basePath}/config`);
  };

  const activeDismissMutation = organizationId
    ? organizationDismissMutation
    : personalDismissMutation;
  const pendingSuggestionId = activeDismissMutation.isPending
    ? activeDismissMutation.variables?.suggestionId
    : undefined;

  const handleSuggestionDismiss = (suggestionId: string) => {
    if (pendingSuggestionId === suggestionId) return;
    if (organizationId) {
      organizationDismissMutation.mutate({ organizationId, suggestionId });
      return;
    }
    personalDismissMutation.mutate({ suggestionId });
  };

  const handleSuggestionCta = async (suggestion: CostSuggestion) => {
    await Promise.race([
      trackSuggestionCta({ suggestionKind: suggestion.type }).catch(() => undefined),
      new Promise(resolve => window.setTimeout(resolve, 500)),
    ]);
    router.push(suggestion.ctaHref);
  };

  const handleSpendRangeChange = (range: SpendRange) => {
    trackUiInteraction({ interaction: 'spend_range_selected', range });
  };

  const handleAlertDriversExpanded = (alertKind: DashboardAlert['type']) => {
    trackUiInteraction({ interaction: 'alert_drivers_expanded', alertKind });
  };

  const alertActionsDisabled = organizationId
    ? organizationAcknowledgeMutation.isPending
    : personalAcknowledgeMutation.isPending;

  return (
    <CostInsightsDashboardView
      data={dashboard}
      isLoading={dashboardLoading}
      isError={dashboardError}
      activityHref={`${basePath}/activity`}
      alertActionsDisabled={alertActionsDisabled}
      pendingSuggestionId={pendingSuggestionId}
      onRetry={() => {
        void (organizationId ? refetchOrganizationDashboard() : refetchPersonalDashboard());
      }}
      onSetupAlerts={() => {
        trackUiInteraction({ interaction: 'setup_alerts_clicked' });
        router.push(`${basePath}/config`);
      }}
      onAlertAction={handleAlertAction}
      onAlertDriversExpanded={handleAlertDriversExpanded}
      onSpendRangeChange={handleSpendRangeChange}
      onSuggestionCta={handleSuggestionCta}
      onSuggestionDismiss={handleSuggestionDismiss}
    />
  );
}
