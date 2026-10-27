/** Resolves the profile layers a new session applies, with the same rules as the server merge. */
'use client';

import { useMemo } from 'react';
import { resolveProfileLayers } from '@kilocode/cloud-agent-profile';
import {
  useCombinedProfiles,
  useProfiles,
  useRepoBindings,
  type ProfileSummaryWithOwner,
} from '@/hooks/useCloudAgentProfiles';

type SessionProfileLayersInput = {
  organizationId?: string;
  selectedOverrideProfileId: string | null;
  repoFullName?: string;
  platform?: 'github' | 'gitlab';
};

export function useSessionProfileLayers({
  organizationId,
  selectedOverrideProfileId,
  repoFullName,
  platform,
}: SessionProfileLayersInput) {
  const {
    data: combinedData,
    isLoading: combinedProfilesLoading,
    error: combinedProfilesError,
    refetch: refetchCombinedProfiles,
  } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const {
    data: personalProfilesData,
    isLoading: personalProfilesLoading,
    error: personalProfilesError,
    refetch: refetchPersonalProfiles,
  } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });
  const profilesLoading = organizationId ? combinedProfilesLoading : personalProfilesLoading;
  const profilesError = organizationId ? combinedProfilesError : personalProfilesError;
  // React Query keeps `error` set while retaining `data` when a background
  // refetch fails (a window-focus refetch, or the invalidation refetch a profile
  // mutation triggers). Only surface the retry state when there is nothing
  // cached to show, so a transient failure never blanks a working picker.
  const profilesData = organizationId ? combinedData : personalProfilesData;
  const refetchProfiles = organizationId ? refetchCombinedProfiles : refetchPersonalProfiles;

  const allProfiles: ProfileSummaryWithOwner[] = useMemo(
    () =>
      organizationId
        ? (combinedData?.allProfiles ?? [])
        : (personalProfilesData ?? []).map(p => ({ ...p, ownerType: 'user' as const })),
    [organizationId, combinedData, personalProfilesData]
  );

  const effectiveDefaultProfileId = organizationId
    ? (combinedData?.effectiveDefaultId ?? null)
    : (personalProfilesData?.find(p => p.isDefault)?.id ?? null);

  const { data: repoBindings } = useRepoBindings({ organizationId });

  const repoBindingProfileId = useMemo(() => {
    if (!repoFullName || !repoBindings) return null;
    const binding = repoBindings.find(
      b =>
        b.repoFullName.toLowerCase() === repoFullName.toLowerCase() &&
        (!platform || b.platform === platform)
    );
    return binding?.profileId ?? null;
  }, [repoFullName, repoBindings, platform]);

  // Shared resolution logic — same rules as the server-side merge.
  const layers = useMemo(
    () =>
      resolveProfileLayers({
        repoBindingProfileId,
        effectiveDefaultProfileId,
        explicitOverrideProfileId: selectedOverrideProfileId,
      }),
    [repoBindingProfileId, effectiveDefaultProfileId, selectedOverrideProfileId]
  );

  const baseProfile = useMemo(
    () => (layers.base ? (allProfiles.find(p => p.id === layers.base?.profileId) ?? null) : null),
    [allProfiles, layers.base]
  );

  const topProfile = useMemo(
    () => (layers.top ? (allProfiles.find(p => p.id === layers.top?.profileId) ?? null) : null),
    [allProfiles, layers.top]
  );

  return {
    allProfiles,
    profilesData,
    profilesLoading,
    profilesError,
    refetchProfiles,
    layers,
    baseProfile,
    topProfile,
  };
}
