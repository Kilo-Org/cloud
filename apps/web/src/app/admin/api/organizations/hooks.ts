import type { OrganizationSortableField } from '@/types/admin';
import type { PageSize } from '@/types/pagination';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useInvalidateAllOrganizationData } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import type { StripeSubscriptionStatusValue } from '@/lib/admin/stripe-subscription-statuses';
import { useEffect } from 'react';

const MAX_TIMEOUT_MS = 2_147_483_647;

export function useDeleteOrganization() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.delete.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: ['organization', variables.organizationId],
        });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
      },
    })
  );
}

export function useGrantOrganizationCredit() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAllOrganizationData();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.grantCredit.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: ['organization', variables.organizationId],
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.admin.creditTransactions.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useNullifyOrganizationCredits() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAllOrganizationData();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.nullifyCredits.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: ['organization', variables.organizationId],
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.admin.creditTransactions.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

type UseOrganizationsListParams = {
  page: number;
  limit: PageSize;
  sortBy: OrganizationSortableField;
  sortOrder: 'asc' | 'desc';
  search: string;
  mode?: 'paying' | 'trial' | 'all';
  include_deleted?: boolean;
  stripe_status?: string;
  plan?: string;
  has_usage?: boolean;
  has_multiple_users?: boolean;
  trial_ending_in_future?: boolean;
};

export function useOrganizationsList(params: UseOrganizationsListParams) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.admin.list.queryOptions({
      page: params.page,
      limit: params.limit,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
      search: params.search,
      mode: params.mode,
      include_deleted: params.include_deleted ?? false,
      stripe_status: params.stripe_status as StripeSubscriptionStatusValue | '' | undefined,
      plan: params.plan as '' | OrganizationPlan | undefined,
      has_usage: params.has_usage ?? false,
      has_multiple_users: params.has_multiple_users ?? false,
      trial_ending_in_future: params.trial_ending_in_future ?? false,
    })
  );
}

export function useAddMember(organizationId: string) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.addMember.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ['organization', organizationId] });
      },
    })
  );
}

export function useAdminOrganizationDetails(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.admin.getDetails.queryOptions({
      organizationId,
    })
  );
}

export function useAdminOrganizationHierarchy(organizationId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.admin.getHierarchy.queryOptions(
      {
        organizationId,
      },
      { enabled }
    )
  );
}

export function useSearchAdminOrganizations(
  search: string,
  limit = 10,
  childOfOrganizationId?: string
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.admin.search.queryOptions(
      {
        search,
        limit,
        childOfOrganizationId,
      },
      { enabled: search.trim().length > 0 }
    )
  );
}

export function useSetParentOrganization(organizationId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAllOrganizationData();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.setParent.mutationOptions({
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.admin.getHierarchy.queryKey({ organizationId }),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.admin.getHierarchy.queryKey({
            organizationId: variables.organizationId,
          }),
        });
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useCreateAdminOrganization(parentOrganizationId?: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAllOrganizationData();
  const trpc = useTRPC();

  return useMutation(
    trpc.organizations.admin.create.mutationOptions({
      onSuccess: () => {
        if (parentOrganizationId) {
          void queryClient.invalidateQueries({
            queryKey: trpc.organizations.admin.getHierarchy.queryKey({
              organizationId: parentOrganizationId,
            }),
          });
        }
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        void invalidate();
      },
    })
  );
}

export function useAdminOrganizationCreditTransactions(organizationId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.admin.creditTransactions.queryOptions({
      organizationId,
    })
  );
}

export function useAdminOrganizationNextCreditExpiration(organizationId: string) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.organizations.admin.nextCreditExpiration.queryOptions({
      organizationId,
    })
  );
  const nextExpirationAt = query.data?.next_credit_expiration_at;
  const refetch = query.refetch;

  useEffect(() => {
    if (!nextExpirationAt) return;

    const expirationTime = new Date(nextExpirationAt).getTime();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleRefetch = () => {
      const remainingMs = expirationTime - Date.now();
      if (remainingMs <= 0) {
        void refetch();
        return;
      }

      timeoutId = setTimeout(scheduleRefetch, Math.min(remainingMs + 100, MAX_TIMEOUT_MS));
    };

    scheduleRefetch();
    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [nextExpirationAt, refetch]);

  return query;
}
