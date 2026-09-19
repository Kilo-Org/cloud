import { type ProfileCountItem } from '@/lib/profile-count-labels';

/**
 * Pure view-model helpers for the mobile profile manager.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-list-model.test.ts`. The screens own rendering; this
 * module owns the section ordering, the effective-default rule, and the
 * compact counts summary the row subtitle shows.
 */

type ProfileSectionKey = 'organization' | 'personal';

/** The three summary counts the list row shows, mirroring the server's `ProfileSummarySchema`. */
export type ProfileCounts = {
  varCount: number;
  commandCount: number;
  skillCount: number;
};

export type ProfileDefaultSource = {
  id: string;
  isDefault: boolean;
};

export type ProfileSection<TProfile> = {
  key: ProfileSectionKey;
  /**
   * Catalog key for the section header. Absent for the single untitled
   * section a personal-context list renders; the screen renders it through
   * `t()` with the reviewed English heading as the fallback.
   */
  titleKey?: string;
  profiles: TProfile[];
};

/**
 * Group profiles into the sections the list renders. A personal context is a
 * single untitled section; an organization context shows Organization then
 * Personal. Empty groups are dropped so the screen never renders a dangling
 * header, and an empty result is the screen's empty state.
 */
export function buildProfileSections<TProfile>({
  orgProfiles,
  personalProfiles,
  isOrgContext,
}: Readonly<{
  orgProfiles: readonly TProfile[];
  personalProfiles: readonly TProfile[];
  isOrgContext: boolean;
}>): ProfileSection<TProfile>[] {
  if (!isOrgContext) {
    return personalProfiles.length > 0
      ? [{ key: 'personal', profiles: [...personalProfiles] }]
      : [];
  }
  const sections: ProfileSection<TProfile>[] = [];
  if (orgProfiles.length > 0) {
    sections.push({
      key: 'organization',
      titleKey: 'profiles.list.organizationHeading',
      profiles: [...orgProfiles],
    });
  }
  if (personalProfiles.length > 0) {
    sections.push({
      key: 'personal',
      titleKey: 'profiles.list.personalHeading',
      profiles: [...personalProfiles],
    });
  }
  return sections;
}

/**
 * Whether `profile` is the profile a session would auto-load.
 *
 * `effectiveDefaultId` is already resolved by the server
 * (`agent-profiles-router.ts` `listCombined`: personal default wins over org
 * default) or by `useAgentProfileList` for a personal context. When it is null
 * no default is resolved, so fall back to the profile's own flag — the same
 * rule the web list uses for a personal context.
 */
export function isEffectiveDefault(
  profile: ProfileDefaultSource,
  effectiveDefaultId: string | null
): boolean {
  return effectiveDefaultId === null ? profile.isDefault : profile.id === effectiveDefaultId;
}

/** Read the counts triple off a profile summary. */
export function profileCounts(profile: ProfileCounts): ProfileCounts {
  return {
    varCount: profile.varCount,
    commandCount: profile.commandCount,
    skillCount: profile.skillCount,
  };
}

/**
 * The non-zero counts a row subtitle shows, in web order (vars, commands,
 * skills). The caller localizes them with the compact unit suffixes and joins
 * them; empty when the profile has nothing configured, so the row renders
 * without a subtitle.
 */
export function profileListCountItems(counts: ProfileCounts): ProfileCountItem[] {
  const items: (ProfileCountItem | null)[] = [
    counts.varCount > 0 ? { kind: 'vars', count: counts.varCount } : null,
    counts.commandCount > 0 ? { kind: 'commands', count: counts.commandCount } : null,
    counts.skillCount > 0 ? { kind: 'skills', count: counts.skillCount } : null,
  ];
  return items.filter((item): item is ProfileCountItem => item !== null);
}
