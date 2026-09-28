import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import {
  resolveSessionProfilePicker,
  type SessionProfilePickerProfile,
} from '@/components/agents/session-profile-picker-model';
import { useTRPC } from '@/lib/trpc';
import { type AgentProfileListItem } from '@/lib/hooks/agent-profile-types';

type ProfileSummary = inferRouterOutputs<MobileRouter>['agentProfiles']['list'][number];
type CombinedProfiles = inferRouterOutputs<MobileRouter>['agentProfiles']['listCombined'];

/** The read-only capability view the new-session form renders. */
export type EffectiveAgentProfile = SessionProfilePickerProfile & {
  commandCount: number;
  agentCount: number;
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
 * Resolve the personal default from a `list` result: the first profile marked
 * `isDefault`, else none.
 */
export function resolvePersonalDefault(profiles: ProfileSummary[]): ProfileSummary | null {
  return profiles.find(profile => profile.isDefault) ?? null;
}

/**
 * Resolve the effective profile from a `listCombined` result. The server has
 * already applied "personal default > org default"; `effectiveDefaultId` names
 * the winner, and this locates its summary in either bucket.
 */
export function resolveCombinedDefault(combined: CombinedProfiles): ProfileSummary | null {
  if (combined.effectiveDefaultId === null) {
    return null;
  }
  return (
    combined.personalProfiles.find(profile => profile.id === combined.effectiveDefaultId) ??
    combined.orgProfiles.find(profile => profile.id === combined.effectiveDefaultId) ??
    null
  );
}

/**
 * Query the current context's agent profiles and resolve the effective default
 * profile. Personal context reads `agentProfiles.list`; org context reads
 * `agentProfiles.listCombined` (whose `effectiveDefaultId` already encodes
 * "personal default > org default > none").
 *
 * `overrideProfileId` is the profile the user picked for this task. When it is
 * null the effective default resolves as before; when it names a profile it
 * replaces the default in the top layer; when it no longer resolves the hook
 * reports `overrideNeedsAttention` and returns no id to submit, so a stale pick
 * is never sent.
 */
export function useEffectiveAgentProfile(
  organizationId?: string,
  overrideProfileId?: string | null
) {
  const trpc = useTRPC();

  const personal = useQuery({
    ...trpc.agentProfiles.list.queryOptions({}),
    enabled: organizationId === undefined,
  });

  const combined = useQuery({
    ...trpc.agentProfiles.listCombined.queryOptions({ organizationId: organizationId ?? '' }),
    enabled: organizationId !== undefined,
  });

  const isOrg = organizationId !== undefined;
  const query = isOrg ? combined : personal;

  const { allProfiles, effectiveDefaultId } = useMemo(() => {
    if (isOrg) {
      const data = combined.data;
      if (!data || !Array.isArray(data.orgProfiles) || !Array.isArray(data.personalProfiles)) {
        return { allProfiles: [] as EffectiveAgentProfile[], effectiveDefaultId: null };
      }
      return {
        allProfiles: [...data.orgProfiles, ...data.personalProfiles].map(profile =>
          toEffective(profile)
        ),
        effectiveDefaultId: data.effectiveDefaultId,
      };
    }
    const profiles = personal.data ?? [];
    return {
      allProfiles: profiles.map(profile => toEffective(profile)),
      effectiveDefaultId: profiles.find(profile => profile.isDefault)?.id ?? null,
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

  // A failed profile query must not leak a cached profile into the form: the
  // error row is shown and Start submits with no effective profile id.
  const profile = query.isError ? null : (picker.topProfile ?? picker.baseProfile);
  const profileId = query.isError ? null : picker.selectedProfileId;

  return {
    profile,
    profileId,
    allProfiles,
    effectiveDefaultId,
    // The user's explicit pick, echoed for the picker's selected row.
    selectedProfileId: overrideProfileId ?? null,
    hasOverride: query.isError ? false : picker.hasOverride,
    overrideNeedsAttention: query.isError ? false : picker.overrideNeedsAttention,
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
