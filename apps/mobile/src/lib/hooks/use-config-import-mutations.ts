import { useMutation, useQueryClient } from '@tanstack/react-query';

import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import { useTRPC } from '@/lib/trpc';

/**
 * The config-import calls the import sheet makes.
 *
 * The sheet renders a refused preview or apply inside itself, so neither
 * carries the profile-editor toast; only a successful apply reconciles the
 * profile reads.
 */
export function useConfigImportMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profilesFilter = trpc.agentProfiles.pathFilter();

  // `networkMode: 'always'` keeps the request settling while the online manager
  // is offline (NetInfo can misreport while the backend is reachable), so the
  // sheet's busy state always returns to idle.
  const previewConfigImport = useMutation(
    withOrganization(
      trpc.agentProfiles.previewConfigImport.mutationOptions({ networkMode: 'always' }),
      organizationId
    )
  );
  const applyConfigImport = useMutation(
    withOrganization(
      trpc.agentProfiles.applyConfigImport.mutationOptions({
        networkMode: 'always',
        onSuccess: () => {
          void queryClient.invalidateQueries(profilesFilter);
        },
      }),
      organizationId
    )
  );

  return { previewConfigImport, applyConfigImport };
}
