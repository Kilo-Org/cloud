import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  resolveSessionProfilePicker,
  type SessionProfilePickerProfile,
} from '@/components/agents/session-profile-picker-model';
import { useTRPC } from '@/lib/trpc';
import { type AgentProfileListItem } from '@/lib/hooks/agent-profile-types';

/** The read-only capability view the new-session form renders. */
export type EffectiveAgentProfile = SessionProfilePickerProfile & {
  ownerType?: AgentProfileListItem['ownerType'];
};

function toEffective(profile: AgentProfileListItem): EffectiveAgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    ownerType: profile.ownerType,
    varCount: profile.varCount,
    mcpServerCount: profile.mcpServerCount,
    skillCount: profile.skillCount,
    kiloCommandCount: profile.kiloCommandCount,
    commandCount: profile.commandCount,
    agentCount: profile.agentCount,
  };
}

/**
 * Query the current context's agent profiles and resolve the effective default
 * profile. Personal context reads `agentProfiles.list`; org context reads
 * `agentProfiles.listCombined` (whose `effectiveDefaultId` already encodes
 * "personal default > org default > none").
 *
 * `overrideProfileId` is the profile the user picked for this task. When it is
 * null the effective default resolves as before. When it names a profile that
 * the read resolves, that profile replaces the default in the top layer and the
 * create submits it. The pick has three states the caller can tell apart:
 *
 *   - a pick that resolves: `resolvedOverrideProfileId` carries its id, so the
 *     form shows the same profile the create submits;
 *   - a pick that no longer resolves after a successful read: the hook reports
 *     `overrideNeedsAttention` and returns no id, so a stale pick is never sent
 *     and Start stays enabled on the default;
 *   - a pick whose read settled with an error: the pick cannot be confirmed, so
 *     the hook returns no id, reports `overrideNeedsAttention`, and the caller's
 *     profile gate blocks Start until the retry resolves the pick.
 */
export function useEffectiveAgentProfile(
  organizationId?: string,
  overrideProfileId?: string | null,
  /**
   * `enabled: false` holds both reads until the caller's scope is resolved. A
   * caller that is still resolving the scope passes it so neither the personal
   * nor the organization read answers for a scope it has not settled yet.
   */
  options: { enabled?: boolean } = {}
) {
  const trpc = useTRPC();
  const enabled = options.enabled ?? true;

  const personal = useQuery({
    ...trpc.agentProfiles.list.queryOptions({}),
    enabled: enabled && organizationId === undefined,
  });

  const combined = useQuery({
    ...trpc.agentProfiles.listCombined.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: enabled && organizationId !== undefined,
  });

  const isOrg = organizationId !== undefined;
  const query = isOrg ? combined : personal;

  const { allProfiles, effectiveDefaultId, effectiveDefaultProfile } = useMemo(() => {
    if (isOrg) {
      const data = combined.data;
      if (!data || !Array.isArray(data.orgProfiles) || !Array.isArray(data.personalProfiles)) {
        return {
          allProfiles: [] as EffectiveAgentProfile[],
          effectiveDefaultId: null,
          effectiveDefaultProfile: null as EffectiveAgentProfile | null,
        };
      }
      const profiles = [...data.orgProfiles, ...data.personalProfiles].map(profile =>
        toEffective(profile)
      );
      return {
        allProfiles: profiles,
        effectiveDefaultId: data.effectiveDefaultId,
        effectiveDefaultProfile:
          profiles.find(profile => profile.id === data.effectiveDefaultId) ?? null,
      };
    }
    const rows = personal.data ?? [];
    const profiles = rows.map(profile => toEffective(profile));
    const defaultId = rows.find(profile => profile.isDefault)?.id ?? null;
    return {
      allProfiles: profiles,
      effectiveDefaultId: defaultId,
      effectiveDefaultProfile: profiles.find(profile => profile.id === defaultId) ?? null,
    };
  }, [isOrg, personal.data, combined.data]);

  const picker = useMemo(
    () =>
      resolveSessionProfilePicker({
        profiles: allProfiles,
        // The server resolves a repo's bound profile from the submitted
        // repository at session creation (profile-session-config), so the
        // mobile picker shows only the default and override layers.
        repoBindingProfileId: null,
        effectiveDefaultProfileId: effectiveDefaultId,
        selectedOverrideProfileId: overrideProfileId ?? null,
      }),
    [allProfiles, effectiveDefaultId, overrideProfileId]
  );

  // A failed profile read never leaks a cached profile into the form: `profile`
  // and `profileId` stay null, so the error row is what the Environment row
  // shows. With no pick the create submits no id and the server applies its
  // default. With a pick the pick cannot be confirmed, so `overrideNeedsAttention`
  // reports it and the caller's profile gate blocks Start until the retry
  // resolves the read.
  const profile = query.isError ? null : (picker.topProfile ?? picker.baseProfile);
  const profileId = query.isError ? null : picker.selectedProfileId;

  return {
    profile,
    profileId,
    allProfiles,
    effectiveDefaultId,
    effectiveDefaultProfile,
    /** The pick the create will submit, or null when nothing picked resolves. */
    resolvedOverrideProfileId:
      query.isError || !picker.hasOverride ? null : (picker.topProfile?.id ?? null),
    overrideNeedsAttention: query.isError
      ? overrideProfileId != null
      : picker.overrideNeedsAttention,
    // Gate on `isPending`, not `isLoading`: in React Query v5 `isLoading` is
    // `isPending && isFetching`, so a paused (offline) first fetch has
    // `isLoading: false` while still unsettled. `isPending` stays true until
    // the query settles (success or error), so Start stays blocked and
    // `profileId` stays unset only after a settled empty or error result.
    // With cached data, a retry keeps error status rather than becoming pending.
    // Keep successful background refreshes visible; only error retries load here.
    isLoading: query.isPending || (query.isError && query.isFetching),
    isError: query.isError,
    refetch: query.refetch,
  };
}
