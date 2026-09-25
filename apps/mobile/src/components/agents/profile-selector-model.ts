import { type ProfileCountItem } from '@/lib/profile-count-labels';

/**
 * Pure option model for the advanced-config profile selector.
 *
 * Ports the web `ProfileSelector` option list (`apps/web/src/components/
 * cloud-agent/ProfileSelector.tsx:84-102,173-222`) to the mobile selector
 * sheet: the no-override row, an Organization Profiles group and a Personal
 * Profiles group (owner icons, effective-default star, per-row var/command
 * counts), then the `Manage profiles...` and `Default Profiles for Repos`
 * entries. The no-override row drops the override and the effective default
 * still applies, so it is labeled `Default profile` whenever the context has
 * one and only says `No profile` when nothing applies at all.
 *
 * No React and no React Native imports: every function here is unit-tested
 * directly in `profile-selector-model.test.ts`. The row owns rendering; this
 * module owns the row list and the selected-row resolution.
 */

export const PROFILE_SELECTOR_KEYS = {
  /**
   * The no-override row when an effective default applies: the row clears the
   * pick and that default is what the session then runs on.
   */
  noOverrideWithDefault: 'profiles.defaultSectionTitle',
  /** The no-override row when no profile would apply: nothing is selected. */
  noProfile: 'agentChat.newSession.noProfile',
  manageProfiles: 'agentChat.newSession.manageProfiles',
  repoDefaults: 'profiles.repoBindings.title',
  organizationProfiles: 'agentChat.newSession.organizationProfiles',
  personalProfiles: 'agentChat.newSession.personalProfiles',
  yourProfiles: 'agentChat.newSession.yourProfiles',
} as const;

export type ProfileSelectorOwnerType = 'organization' | 'user';

/** One profile as the selector lists it. */
export type ProfileSelectorProfile = Readonly<{
  id: string;
  name: string;
  varCount: number;
  commandCount: number;
  isDefault: boolean;
  ownerType: ProfileSelectorOwnerType;
}>;

/**
 * One row of the selector sheet, in render order. A `header` row opens a
 * group; `profile` rows are the choices; `none`, `manage` and `repo-defaults`
 * are the fixed entries. The `none` row is the no-override choice: it clears
 * the pick, so it names the effective default when the context has one.
 */
export type ProfileSelectorRow =
  | Readonly<{ kind: 'none'; key: 'none'; labelKey: string }>
  | Readonly<{ kind: 'header'; key: 'organization' | 'personal'; labelKey: string }>
  | Readonly<{
      kind: 'profile';
      key: string;
      profile: ProfileSelectorProfile;
      isEffectiveDefault: boolean;
    }>
  | Readonly<{ kind: 'manage'; key: 'manage'; labelKey: string }>
  | Readonly<{ kind: 'repo-defaults'; key: 'repo-defaults'; labelKey: string }>;

export type ProfileSelectorState = Readonly<{
  rows: ProfileSelectorRow[];
  /** The selected profile, or null when the id names nothing in the list. */
  selectedProfile: ProfileSelectorProfile | null;
  /** True when the selected profile is the effective default for the context. */
  selectedIsEffectiveDefault: boolean;
  /**
   * The label for the `none` row and for the closed selector row while no
   * override is picked: `Default profile` when an effective default applies,
   * `No profile` when nothing does.
   */
  noOverrideLabelKey: string;
}>;

/**
 * The per-row count the web selector appends. Both counts render even at zero
 * (web parity), in var-then-command order; the caller localizes and joins
 * them. Empty when both counts are zero, so the row renders no count at all.
 */
export function profileSelectorCountItems(profile: ProfileSelectorProfile): ProfileCountItem[] {
  if (profile.varCount === 0 && profile.commandCount === 0) {
    return [];
  }
  return [
    { kind: 'vars', count: profile.varCount },
    { kind: 'commands', count: profile.commandCount },
  ];
}

export type BuildProfileSelectorStateInput = Readonly<{
  /** The route's organization scope; `undefined` is a personal context. */
  organizationId?: string;
  /** Organization profiles; ignored in personal context. */
  orgProfiles: readonly ProfileSelectorProfile[];
  /** Personal profiles (the `list` result in personal context). */
  personalProfiles: readonly ProfileSelectorProfile[];
  /** `listCombined.effectiveDefaultId`, or the personal default's id. */
  effectiveDefaultId: string | null;
  /** The profile the form currently holds as an override, or null for none. */
  selectedProfileId: string | null;
  /**
   * Whether to offer the `Default profiles for repos...` entry. The caller
   * omits it until the repo-bindings surface exists, so no dead entry shows.
   */
  includeRepoDefaults?: boolean;
}>;

/**
 * Build the selector's row list and selected row. In org context the effective
 * default is `effectiveDefaultId` for both groups; in personal context it is
 * the profile's own `isDefault` flag (matching the web selector).
 */
export function buildProfileSelectorState({
  organizationId,
  orgProfiles,
  personalProfiles,
  effectiveDefaultId,
  selectedProfileId,
  includeRepoDefaults = true,
}: BuildProfileSelectorStateInput): ProfileSelectorState {
  const isOrganization = organizationId !== undefined;
  const allProfiles = [...orgProfiles, ...personalProfiles];
  const selectedProfile = allProfiles.find(profile => profile.id === selectedProfileId) ?? null;
  const isEffectiveDefault = (profile: ProfileSelectorProfile): boolean =>
    isOrganization ? profile.id === effectiveDefaultId : profile.isDefault;
  // The no-override row hands the session to the effective default, so it only
  // claims `No profile` when the context resolves none. Personal context reads
  // the personal list, the same one the star and the selection use.
  const contextProfiles = isOrganization ? allProfiles : personalProfiles;
  const noOverrideLabelKey = contextProfiles.some(profile => isEffectiveDefault(profile))
    ? PROFILE_SELECTOR_KEYS.noOverrideWithDefault
    : PROFILE_SELECTOR_KEYS.noProfile;

  const rows: ProfileSelectorRow[] = [{ kind: 'none', key: 'none', labelKey: noOverrideLabelKey }];

  if (isOrganization && orgProfiles.length > 0) {
    rows.push({
      kind: 'header',
      key: 'organization',
      labelKey: PROFILE_SELECTOR_KEYS.organizationProfiles,
    });
    for (const profile of orgProfiles) {
      rows.push({
        kind: 'profile',
        key: profile.id,
        profile,
        isEffectiveDefault: isEffectiveDefault(profile),
      });
    }
  }

  if (personalProfiles.length > 0) {
    rows.push({
      kind: 'header',
      key: 'personal',
      labelKey: isOrganization
        ? PROFILE_SELECTOR_KEYS.personalProfiles
        : PROFILE_SELECTOR_KEYS.yourProfiles,
    });
    for (const profile of personalProfiles) {
      rows.push({
        kind: 'profile',
        key: profile.id,
        profile,
        isEffectiveDefault: isEffectiveDefault(profile),
      });
    }
  }

  rows.push({ kind: 'manage', key: 'manage', labelKey: PROFILE_SELECTOR_KEYS.manageProfiles });
  if (includeRepoDefaults) {
    rows.push({
      kind: 'repo-defaults',
      key: 'repo-defaults',
      labelKey: PROFILE_SELECTOR_KEYS.repoDefaults,
    });
  }

  return {
    rows,
    selectedProfile,
    selectedIsEffectiveDefault: selectedProfile !== null && isEffectiveDefault(selectedProfile),
    noOverrideLabelKey,
  };
}
