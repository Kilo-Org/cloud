import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { Organization } from '@kilocode/db/schema';
import type { OrgTrialStatus, TimePeriod } from '@/lib/organizations/organization-types';
import { classifyOrganizationEntitlement } from '@/lib/organizations/trial-utils';
import { z } from 'zod';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';

export function useOrganizationWithMembers(id: string, options?: { enabled?: boolean }) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.withMembers.queryOptions(
      { organizationId: id },
      {
        ...options,
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      }
    )
  );
}

const useInvalidateOrganizationAndMembers = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return function (_: unknown, { organizationId }: { organizationId: Organization['id'] }) {
    void queryClient.invalidateQueries({
      queryKey: trpc.organizations.withMembers.queryKey({ organizationId }),
    });
  };
};

export const useInvalidateAllOrganizationData = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return async function () {
    await queryClient.invalidateQueries({
      queryKey: trpc.organizations.pathKey(),
    });
  };
};

export function useOrganizationUsageDetails(
  organizationId: string,
  timePeriod: string = 'week',
  userFilter: string = 'all',
  groupByModel: boolean = false
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.usageDetails.get.queryOptions({
      organizationId,
      period: timePeriod as 'week' | 'month' | 'year' | 'all',
      userFilter: userFilter as 'all' | 'me',
      groupByModel,
    })
  );
}

export function useOrganizationUsageTimeseries(
  organizationId: string,
  startDate: string,
  endDate: string,
  options?: { enabled?: boolean }
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.usageDetails.getTimeSeries.queryOptions(
      {
        organizationId,
        startDate,
        endDate,
      },
      options
    )
  );
}

export function useOrganizationCreditTransactions(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.creditTransactions.queryOptions({ organizationId }));
}

export function useOrganizationUsageStats(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.usageStats.queryOptions({ organizationId }));
}

export function useOrganizationAutocompleteMetrics(
  organizationId: string,
  period: TimePeriod = 'month'
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.usageDetails.getAutocomplete.queryOptions({
      organizationId,
      period,
    })
  );
}

export function useOrganizationInvoices(organizationId: string, timePeriod: string = 'year') {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.invoices.queryOptions({
      organizationId,
      period: timePeriod as 'week' | 'month' | 'year' | 'all',
    })
  );
}

/// MUTATIONS ///
export function useUpdateMemberRole() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();
  return useMutation(
    trpc.organizations.members.update.mutationOptions({
      onSuccess,
    })
  );
}

export function useRemoveMember() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.members.remove.mutationOptions({
      onSuccess,
    })
  );
}

export function useDeleteOrganizationInvitation() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.members.deleteInvite.mutationOptions({
      onSuccess,
    })
  );
}

export function useInviteMember() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.members.invite.mutationOptions({
      onSuccess,
    })
  );
}

export function useUpdateOrganizationName() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();
  return useMutation(
    trpc.organizations.update.mutationOptions({
      onSuccess,
    })
  );
}

export function useUpdateCompanyDomain() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();
  return useMutation(
    trpc.organizations.updateCompanyDomain.mutationOptions({
      onSuccess,
    })
  );
}

export function useUpdateOrganizationSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.settings.updateAllowLists.mutationOptions({
      onSuccess: () => {
        // lazy-mode invalidate everything related to an org if settings change
        void queryClient.invalidateQueries({ queryKey: trpc.organizations.pathKey() });
      },
    })
  );
}

export function useUpdateDefaultModel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.settings.updateDefaultModel.mutationOptions({
      onSuccess: () => {
        // lazy-mode invalidate everything related to an org if settings change
        void queryClient.invalidateQueries({ queryKey: trpc.organizations.pathKey() });
      },
    })
  );
}

export function useUpdateOrganizationSeatsRequired() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.updateSeatsRequired.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useUpdateOrganizationPlan() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.updatePlan.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useUpdateOrganizationFreeTrialEndAt() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.admin.updateFreeTrialEndAt.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useUpdateSuppressTrialMessaging() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.admin.updateSuppressTrialMessaging.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useAdminToggleCodeIndexing() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.settings.updateCodeIndexingFeatureFlag.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useUpdateMinimumBalanceAlert() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.settings.updateMinimumBalanceAlert.mutationOptions({
      onSuccess: () => {
        // Invalidate organization data to refresh settings
        void queryClient.invalidateQueries({ queryKey: trpc.organizations.pathKey() });
      },
    })
  );
}

export function useEnableOssSponsorship() {
  const trpc = useTRPC();
  const invalidate = useInvalidateAllOrganizationData();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.admin.ossSponsorship.addExistingOrgToOss.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void queryClient.invalidateQueries({
          queryKey: trpc.admin.ossSponsorship.listOssSponsorships.queryKey(),
        });
        void invalidate();
      },
    })
  );
}

export function useUpdateDailyUsageLimitUsd() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();

  return useMutation(
    trpc.organizations.members.update.mutationOptions({
      onSuccess,
    })
  );
}

export function useCreateOrganization() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.organizations.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.organizations.pathKey() });
      },
    })
  );
}

export function useOrganizationSeatUsage(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.seats.queryOptions(
      { organizationId },
      {
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      }
    )
  );
}

/// SUBSCRIPTION HOOKS ///

export function useOrganizationSubscription(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId },
      {
        enabled: !!organizationId,
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      }
    )
  );
}

export function useOrganizationLatestSeatPurchaseStatus(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.getLatestSeatPurchaseStatus.queryOptions(
      { organizationId },
      {
        enabled: !!organizationId,
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      }
    )
  );
}

export function useResubscribeDefaults(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.getResubscribeDefaults.queryOptions(
      { organizationId },
      {
        enabled: !!organizationId,
      }
    )
  );
}

export function useOrganizationSubscriptionLink() {
  const trpc = useTRPC();
  return useMutation(trpc.organizations.subscription.getSubscriptionStripeUrl.mutationOptions());
}
export function useCancelOrganizationSubscription() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();

  return useMutation(
    trpc.organizations.subscription.cancel.mutationOptions({
      onSuccess,
    })
  );
}

export function useStopOrganizationSubscriptionCancellation() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();

  return useMutation(
    trpc.organizations.subscription.stopCancellation.mutationOptions({
      onSuccess,
    })
  );
}

export function useChangeBillingCycle() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.subscription.changeBillingCycle.mutationOptions({
      onSuccess,
    })
  );
}

export function useCancelBillingCycleChange() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.subscription.cancelBillingCycleChange.mutationOptions({
      onSuccess,
    })
  );
}

export function useUpdateOrganizationSeatCount() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateAllOrganizationData();
  return useMutation(
    trpc.organizations.subscription.updateSeatCount.mutationOptions({
      onSuccess,
    })
  );
}

export function useGetCustomerPortalUrl() {
  const trpc = useTRPC();
  return useMutation(trpc.organizations.subscription.getCustomerPortalUrl.mutationOptions());
}

/// SSO DOMAIN HOOKS ///

export function useUpdateOrganizationSsoDomain() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();
  return useMutation(
    trpc.organizations.sso.updateSsoDomain.mutationOptions({
      onSuccess,
    })
  );
}

export function useClearOrganizationSsoDomain() {
  const trpc = useTRPC();
  const onSuccess = useInvalidateOrganizationAndMembers();
  return useMutation(
    trpc.organizations.sso.clearSsoDomain.mutationOptions({
      onSuccess,
    })
  );
}

export function useOrganizationAvailableModels(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.settings.listAvailableModels.queryOptions({ organizationId }));
}

/// CUSTOM MODES HOOKS ///

export function useOrganizationModes(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.organizations.modes.list.queryOptions({ organizationId }));
}

export function useOrganizationModeById(organizationId: string, modeId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.modes.getById.queryOptions({ organizationId, modeId }, { enabled: !!modeId })
  );
}

export function useCreateOrganizationMode() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.modes.create.mutationOptions({
      onSuccess: (_, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.modes.list.queryKey({
            organizationId: variables.organizationId,
          }),
        });
      },
    })
  );
}

export function useUpdateOrganizationMode() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.modes.update.mutationOptions({
      onSuccess: (_, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.modes.list.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.modes.getById.queryKey({
            organizationId: variables.organizationId,
            modeId: variables.modeId,
          }),
        });
      },
    })
  );
}

export function useDeleteOrganizationMode() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.modes.delete.mutationOptions({
      onSuccess: (_, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.modes.list.queryKey({
            organizationId: variables.organizationId,
          }),
        });
      },
    })
  );
}

export type OrganizationAIAdoptionProps = Partial<
  ReturnType<typeof useOrganizationAIAdoptionTimeseries>
>;

export function useOrganizationAIAdoptionTimeseries(
  organizationId: string,
  startDate: string,
  endDate: string
) {
  const trpc = useTRPC();
  const { data, error, isLoading } = useQuery(
    // we previously conditionally enabled this query based on whether or not the
    // user was a kilo admin. We no longer do that, but I'm going to leave the
    // Object.assign and enabled: true here in case we need to add it back.
    Object.assign(
      trpc.organizations.usageDetails.getAIAdoptionTimeseries.queryOptions(
        {
          organizationId,
          startDate,
          endDate,
        },
        {
          trpc: {
            context: {
              skipBatch: true,
            },
          },
        }
      ),
      {
        enabled: true,
      }
    )
  );

  return { ...data, error, isLoading };
}

export function useOrganizationTrialStatus(
  organizationId: string
): OrgTrialStatus | 'loading' | 'error' {
  const sub = useOrganizationLatestSeatPurchaseStatus(organizationId);
  const org = useOrganizationWithMembers(organizationId);

  if (sub.error || org.error) {
    console.error('error loading', sub.error, org.error);
    return 'error';
  }

  if (!sub.data || !org.data) {
    return 'loading';
  }

  const classification = classifyOrganizationEntitlement({
    organization: org.data,
    latestSeatPurchaseStatus: sub.data.latestSeatPurchaseStatus,
    now: new Date(),
  });

  return classification.displayStatus;
}

// Schema for organization defaults response
const OrganizationDefaultsResponseSchema = z.object({
  defaultModel: z.string(),
});

type OrganizationDefaultsResponse = z.infer<typeof OrganizationDefaultsResponseSchema>;

export function useOrganizationDefaults(organizationId?: string) {
  return useQuery<OrganizationDefaultsResponse>({
    queryKey: ['organization-defaults', organizationId],
    queryFn: async (): Promise<OrganizationDefaultsResponse> => {
      if (!organizationId) {
        return { defaultModel: PRIMARY_DEFAULT_MODEL };
      }

      const response = await fetch(`/api/organizations/${organizationId}/defaults`);
      if (!response.ok) {
        throw new Error(`Failed to fetch defaults: ${response.status} ${response.statusText}`);
      }
      const body = await response.json();
      return OrganizationDefaultsResponseSchema.parse(body);
    },
    enabled: true,
  });
}
