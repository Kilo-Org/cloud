import type { OrganizationSortableField } from '@/types/admin';
import type { PageSize } from '@/types/pagination';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useInvalidateAllOrganizationData } from '@/app/api/organizations/hooks';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';

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
          queryKey: ['organization', variables.organizationId, 'credit-transactions'],
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
          queryKey: ['organization', variables.organizationId, 'credit-transactions'],
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
  seatsRequired?: string;
  hasBalance?: string;
  status?: string;
  plan?: string;
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
      seatsRequired: params.seatsRequired as '' | 'true' | 'false' | undefined,
      hasBalance: params.hasBalance as '' | 'true' | 'false' | undefined,
      status: params.status as 'active' | 'all' | 'incomplete' | 'deleted' | undefined,
      plan: params.plan as '' | OrganizationPlan | undefined,
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
