'use client';

import { resolveProfileLayers } from '@kilocode/cloud-agent-profile';
import {
  useCombinedProfiles,
  useProfile,
  useProfiles,
  useRepoBindings,
} from './useCloudAgentProfiles';

/** Load the same two layers as session creation, without copying their configuration. */
export function useEnvironmentProfiles({
  organizationId,
  repository,
  selectedProfileId,
}: {
  organizationId?: string;
  repository?: { platform: string; fullName: string };
  selectedProfileId?: string | null;
}) {
  const personal = useProfiles({ enabled: !organizationId });
  const combined = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const bindings = useRepoBindings({ organizationId });
  const summaries = organizationId ? combined.data?.allProfiles : personal.data;
  const binding =
    repository?.platform === 'bitbucket'
      ? undefined
      : bindings.data?.find(
          candidate =>
            candidate.platform === repository?.platform &&
            candidate.repoFullName.toLowerCase() === repository.fullName.toLowerCase()
        );
  const layers = resolveProfileLayers({
    repoBindingProfileId: binding?.profileId ?? null,
    effectiveDefaultProfileId: organizationId
      ? (combined.data?.effectiveDefaultId ?? null)
      : (personal.data?.find(profile => profile.isDefault)?.id ?? null),
    explicitOverrideProfileId: selectedProfileId ?? null,
  });
  const ownerFor = (id: string | undefined) =>
    organizationId &&
    combined.data?.allProfiles.find(profile => profile.id === id)?.ownerType === 'organization'
      ? organizationId
      : undefined;
  const base = useProfile(layers.base?.profileId ?? '', {
    organizationId: ownerFor(layers.base?.profileId),
    enabled: !!summaries,
  });
  const top = useProfile(layers.top?.profileId ?? '', {
    organizationId: ownerFor(layers.top?.profileId),
    enabled: !!summaries,
  });
  const queries = [
    organizationId ? combined : personal,
    bindings,
    ...(layers.base ? [base] : []),
    ...(layers.top ? [top] : []),
  ];
  return {
    profiles: [base.data, top.data].filter(profile => profile !== undefined),
    isLoading: queries.some(query => query.isPending),
    isError: queries.some(query => query.isError),
    retry: () => Promise.all(queries.map(query => query.refetch())),
  };
}
