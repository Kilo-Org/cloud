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
 * Read the visible custom agents of `profileId` for the new-session mode picker
 * and model lock. The caller resolves the id — the Environment picker's explicit
 * selection, else the effective default — so the picker and a selected agent's
 * pinned model follow the same profile the Environment row and the create body
 * use. A missing or failed profile degrades to empty custom options (built-ins
 * only), matching web.
 */
export function useEffectiveProfileCustomModes(
  organizationId?: string,
  profileId?: string | null
): EffectiveProfileCustomModes {
  const trpc = useTRPC();

  const listCombined = useQuery(
    trpc.agentProfiles.listCombined.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: Boolean(organizationId) }
    )
  );

  const effectiveId = profileId ?? null;

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
