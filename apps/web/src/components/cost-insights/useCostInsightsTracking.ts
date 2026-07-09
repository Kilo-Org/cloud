'use client';

import { useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc/utils';
import type {
  CostInsightsSuggestionCta,
  CostInsightsUiInteraction,
} from '@/lib/cost-insights/tracking';

export function useCostInsightsTracking(organizationId?: string) {
  const trpc = useTRPC();
  const { mutate: trackPersonalInteraction } = useMutation(
    trpc.costInsights.trackUiInteraction.mutationOptions()
  );
  const { mutate: trackOrganizationInteraction } = useMutation(
    trpc.organizations.costInsights.trackUiInteraction.mutationOptions()
  );
  const { mutateAsync: trackPersonalSuggestionCta } = useMutation(
    trpc.costInsights.trackSuggestionCta.mutationOptions()
  );
  const { mutateAsync: trackOrganizationSuggestionCta } = useMutation(
    trpc.organizations.costInsights.trackSuggestionCta.mutationOptions()
  );

  const trackUiInteraction = useCallback(
    (interaction: CostInsightsUiInteraction) => {
      if (organizationId) {
        trackOrganizationInteraction({ organizationId, ...interaction });
        return;
      }
      trackPersonalInteraction(interaction);
    },
    [organizationId, trackOrganizationInteraction, trackPersonalInteraction]
  );

  const trackSuggestionCta = useCallback(
    async (suggestion: CostInsightsSuggestionCta) => {
      if (organizationId) {
        await trackOrganizationSuggestionCta({ organizationId, ...suggestion });
        return;
      }
      await trackPersonalSuggestionCta(suggestion);
    },
    [organizationId, trackOrganizationSuggestionCta, trackPersonalSuggestionCta]
  );

  return { trackUiInteraction, trackSuggestionCta };
}
