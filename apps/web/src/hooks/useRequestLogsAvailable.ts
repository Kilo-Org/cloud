import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

/** Whether the caller should see the organization's Request Logs page. */
export function useRequestLogsAvailable(organizationId: string, canView: boolean): boolean {
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.organizations.requestLogs.isAvailable.queryOptions({ organizationId }),
    enabled: canView,
  });
  return canView && data?.available === true;
}
