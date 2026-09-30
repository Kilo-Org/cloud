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
 * Read a profile's visible custom agents for the new-session mode picker and
 * model lock. With no `profileId`, that is the effective default profile:
 * personal context uses the first `list` row with `isDefault`; org context uses
 * `listCombined.effectiveDefaultId`. An explicit `profileId` (the session's own
 * recorded or bound profile) wins, so an in-session role picker offers that
 * profile's agents rather than the context default's. A failed or missing
 * profile degrades to empty custom options (built-ins only), matching web.
 */
export function useEffectiveProfileCustomModes(
  organizationId?: string,
  profileId?: string | null
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
  const targetProfileId = profileId ?? effectiveId;

  // Scope the `get` by the profile's own owner. In an org context the combined
  // read carries both buckets, so a personal profile referenced from a session
  // is fetched without the organization id, exactly as an org profile is
  // fetched with it.
  const isOrgProfile =
    Boolean(targetProfileId) &&
    Boolean(organizationId) &&
    (listCombined.data?.orgProfiles.some(profile => profile.id === targetProfileId) ?? false);
  const getOrg = isOrgProfile ? organizationId : undefined;

  const get = useQuery(
    trpc.agentProfiles.get.queryOptions(
      { profileId: targetProfileId ?? '', ...(getOrg ? { organizationId: getOrg } : {}) },
      { enabled: Boolean(targetProfileId) }
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
