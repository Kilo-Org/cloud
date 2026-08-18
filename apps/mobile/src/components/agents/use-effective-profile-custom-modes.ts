import { useQuery } from '@tanstack/react-query';

import {
  customModeOptionsFromProfileAgents,
  dedupeCustomModeOptions,
  type ModeOption,
  visibleProfileAgents,
} from '@/components/agents/mode-normalize';
import { useTRPC } from '@/lib/trpc';

type EffectiveProfileCustomModes = {
  customOptions: ModeOption[];
  profileAgents: ReturnType<typeof visibleProfileAgents>;
  isLoading: boolean;
};

/**
 * Read the effective default profile's visible custom agents for the new-session
 * mode picker and model lock. Personal context uses the first `list` row with
 * `isDefault`; org context uses `listCombined.effectiveDefaultId`. A failed or
 * missing profile degrades to empty custom options (built-ins only), matching
 * web.
 */
export function useEffectiveProfileCustomModes(
  organizationId?: string
): EffectiveProfileCustomModes {
  const trpc = useTRPC();

  const list = useQuery(trpc.agentProfiles.list.queryOptions({}, { enabled: !organizationId }));
  const listCombined = useQuery(
    trpc.agentProfiles.listCombined.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: Boolean(organizationId) }
    )
  );

  const effectiveId = organizationId
    ? (listCombined.data?.effectiveDefaultId ?? null)
    : (list.data?.find(profile => profile.isDefault)?.id ?? null);

  const isOrgProfile =
    Boolean(effectiveId) &&
    Boolean(organizationId) &&
    (listCombined.data?.orgProfiles.some(profile => profile.id === effectiveId) ?? false);
  const getOrg = isOrgProfile ? organizationId : undefined;

  const get = useQuery(
    trpc.agentProfiles.get.queryOptions(
      { profileId: effectiveId ?? '', ...(getOrg ? { organizationId: getOrg } : {}) },
      { enabled: Boolean(effectiveId) }
    )
  );

  const profileAgents = visibleProfileAgents(get.data?.agents ?? []);
  const customOptions = dedupeCustomModeOptions(customModeOptionsFromProfileAgents(profileAgents));

  return {
    customOptions,
    profileAgents,
    isLoading: get.isLoading,
  };
}
