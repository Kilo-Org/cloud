import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

import { type ProfileOwnerChoice } from '@/components/profiles/profile-owner-model';
import { openedFromQuery, type ProfileExternalOpener } from '@/lib/profile-route-stack';

type ProfileOrganization = { organizationId: string };

/**
 * Which Stack renders the profile-management screens.
 *
 * `profileTab` is the Profile tab's own stack: the Profile tab's rows push the
 * screens there, and the tab bar stays visible. `app` is the root `(app)` Stack
 * that also holds `agent-chat/new` and the agent session screens. A screen
 * entered from one of those must be pushed on `app`: a push that crosses into
 * the tabs navigator leaves the composer behind it, so Back lands on the tab
 * root instead of the screen that opened the profile screen.
 */
export type ProfileManagementStack = 'app' | 'profileTab';

/**
 * Route roots per Stack. Both trees render the same screen components; only
 * the tree differs, because Expo Router resolves an href inside the navigator
 * that owns it. A screen opened from the root stack must travel through
 * `app`, and one opened from the Profile tab through `profileTab`, or Back
 * unwinds the wrong navigator.
 */
const PROFILE_ROOTS = {
  app: '/(app)/profile-management',
  profileTab: '/(app)/(tabs)/(3_profile)/profiles',
} as const;

/**
 * The name the profiles list registers under inside each Stack. Expo Router
 * names a screen after its file below the layout that declares it, and an
 * `index.tsx` keeps the `index` segment, the same shape the layouts rely on
 * (`unstable_settings.initialRouteName: 'index'`).
 */
const PROFILE_LIST_ROUTE_NAMES = {
  app: 'profile-management/index',
  profileTab: 'profiles/index',
} as const;

/**
 * The route names of the profile screens below the list, per Stack, keyed the
 * way the route files are named. A Stack's navigation state names a screen by
 * its file path below the layout that declares it, so these are the strings a
 * repair compares against (`profile-route-stack.ts`).
 */
const PROFILE_SCREEN_ROUTE_NAMES = {
  app: {
    new: 'profile-management/new',
    repoBindings: 'profile-management/repo-bindings',
    overview: 'profile-management/[profileId]/index',
    sections: {
      agents: 'profile-management/[profileId]/agents',
      commands: 'profile-management/[profileId]/commands',
      mcp: 'profile-management/[profileId]/mcp',
      skills: 'profile-management/[profileId]/skills',
      'slash-commands': 'profile-management/[profileId]/slash-commands',
      variables: 'profile-management/[profileId]/variables',
    },
  },
  profileTab: {
    new: 'profiles/new',
    repoBindings: 'profiles/repo-bindings',
    overview: 'profiles/[profileId]/index',
    sections: {
      agents: 'profiles/[profileId]/agents',
      commands: 'profiles/[profileId]/commands',
      mcp: 'profiles/[profileId]/mcp',
      skills: 'profiles/[profileId]/skills',
      'slash-commands': 'profiles/[profileId]/slash-commands',
      variables: 'profiles/[profileId]/variables',
    },
  },
} as const;

/** One of the profile editor's section screens. */
export type ProfileSectionName = keyof (typeof PROFILE_SCREEN_ROUTE_NAMES)['app']['sections'];

/** The route name the profile overview registers under in the given Stack. */
export function getProfileOverviewRouteName(stack: ProfileManagementStack = 'profileTab'): string {
  return PROFILE_SCREEN_ROUTE_NAMES[stack].overview;
}

/** The route name a profile section registers under in the given Stack. */
export function getProfileSectionRouteName(
  section: ProfileSectionName,
  stack: ProfileManagementStack = 'profileTab'
): string {
  return PROFILE_SCREEN_ROUTE_NAMES[stack].sections[section];
}

/**
 * Every route name of the profile tree in the given Stack. The layouts read
 * this to register the same screen options on each of them.
 */
export function getProfileRouteNames(
  stack: ProfileManagementStack = 'profileTab'
): readonly string[] {
  const names = PROFILE_SCREEN_ROUTE_NAMES[stack];
  return [
    PROFILE_LIST_ROUTE_NAMES[stack],
    names.new,
    names.repoBindings,
    names.overview,
    ...Object.values(names.sections),
  ];
}

export function getProfileAgentScope(
  selectedOrganizationId: string | null,
  organizations: readonly ProfileOrganization[] | undefined
): string | undefined {
  if (!selectedOrganizationId) {
    return PERSONAL_SECURITY_SCOPE;
  }
  // A list already in hand resolves the scope, including while a background
  // refresh runs: gating on the refresh left both agent rows disabled for as
  // long as a stalled refresh lasted, with no error and no way to open them.
  // Only the absence of any list -- before the first load -- keeps them waiting.
  if (!organizations) {
    return undefined;
  }
  // A settled list that no longer contains the selection means the membership
  // was lost, not that the reader chose Personal: substituting Personal here
  // opened the agent's personal first-run state under an organization name the
  // reader still has selected. Keep the id so the organization scope can say
  // that access is gone and offer the way back.
  return selectedOrganizationId;
}

export function getCodeReviewerProfilePath(scope: string): Href {
  return `/(app)/code-reviewer/${scope}` as Href;
}

/**
 * Where the Code Reviewer screens land when they have no history: the Home
 * tab's root, which holds the EXPLORE card that opens the reviewer. Both of the
 * reviewer's entry points push its screens (the Home card and the Profile row),
 * so a cold link or a relaunch restore that opened one on its own still has one
 * place to return to.
 */
export const CODE_REVIEWER_HOME_PATH = '/(app)/(tabs)/(0_home)' as Href;

export function getPrReviewEntryPath(): Href {
  return '/(app)/pr-review' as Href;
}

/**
 * Profile context carried by a profile route. Org-owned profiles travel with
 * their `organizationId`; a personal profile has none, exactly like the tRPC
 * `agentProfiles.*` inputs.
 *
 * A screen opened on purpose from outside the profile tree also carries its
 * opener (`profile-route-stack.ts`), which keeps Back with that screen instead
 * of building the profiles list beneath it.
 */
function profileContextQuery(organizationId?: string, openedFrom?: ProfileExternalOpener): string {
  const parts = [
    organizationId === undefined ? '' : `organizationId=${encodeURIComponent(organizationId)}`,
    openedFrom === undefined ? '' : openedFromQuery(openedFrom),
  ].filter(part => part.length > 0);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The Manage Profiles entry on the Profile tab. */
export function getProfilesPath(stack: ProfileManagementStack = 'profileTab'): Href {
  return PROFILE_ROOTS[stack] as Href;
}

/** The route name the profiles list registers under in the given Stack. */
export function getProfilesRouteName(stack: ProfileManagementStack = 'profileTab'): string {
  return PROFILE_LIST_ROUTE_NAMES[stack];
}

/** Where the repo-to-profile defaults screen is opened from. */
export type RepoBindingsPathOptions = {
  organizationId?: string;
  stack?: ProfileManagementStack;
  /**
   * The outside screen that deliberately opened it: the new-session composer
   * passes `composer`, so Back returns to the form that asked.
   */
  openedFrom?: ProfileExternalOpener;
};

/** The repo-to-profile default bindings screen. */
export function getRepoBindingsPath(options: RepoBindingsPathOptions = {}): Href {
  const stack = options.stack ?? 'profileTab';
  return `${PROFILE_ROOTS[stack]}/repo-bindings${profileContextQuery(
    options.organizationId,
    options.openedFrom
  )}` as Href;
}

/** What the create screen does after it saves, besides opening the new profile. */
export type NewProfileReturn = 'back';

/** The returns the create route accepts: `back` hands the form back to its caller. */
export const NEW_PROFILE_RETURNS: readonly NewProfileReturn[] = ['back'];

/** The owner and the return a caller of the create screen asks for. */
export type NewProfilePathOptions = {
  /** The owner the form starts on. The user can still switch it. */
  owner?: ProfileOwnerChoice;
  /** `back` returns to the caller instead of opening the new profile. */
  returnTo?: NewProfileReturn;
  /**
   * The organization the caller is scoped to. The form resolves its boundary
   * from it, so a caller whose scope is not the active account still creates
   * the profile in the organization whose list it showed.
   */
  organizationId?: string;
};

/** The profile editor's create screen. */
export function getNewProfilePath(
  stack: ProfileManagementStack = 'profileTab',
  options: NewProfilePathOptions = {}
): Href {
  const query = [
    options.owner === undefined ? '' : `owner=${options.owner}`,
    options.returnTo === undefined ? '' : `returnTo=${options.returnTo}`,
    options.organizationId === undefined
      ? ''
      : `organizationId=${encodeURIComponent(options.organizationId)}`,
  ]
    .filter(part => part.length > 0)
    .join('&');
  return `${PROFILE_ROOTS[stack]}/new${query.length > 0 ? `?${query}` : ''}` as Href;
}

/**
 * The profile editor's Overview tab (the profile's own route). An agent session
 * opens it with `openedFrom: 'session'`, so Back returns to the session whose
 * profile chip opened it.
 */
/** Where the overview route is opened from, when it is not the profile list. */
export type ProfileOverviewPathOptions = {
  /** The organization that owns the profile. */
  organizationId?: string;
  /** The Stack the overview joins. */
  stack?: ProfileManagementStack;
  /** The outside screen that deliberately opened it. */
  openedFrom?: ProfileExternalOpener;
};

export function getProfileOverviewPath(
  profileId: string,
  options: ProfileOverviewPathOptions = {}
): Href {
  const stack = options.stack ?? 'profileTab';
  return `${PROFILE_ROOTS[stack]}/${profileId}${profileContextQuery(options.organizationId, options.openedFrom)}` as Href;
}

/** The profile editor's Variables tab. */
export function getProfileVariablesPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/variables${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Setup Commands tab. */
export function getProfileCommandsPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/commands${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Slash Commands tab. */
export function getProfileSlashCommandsPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/slash-commands${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's MCP Servers tab. */
export function getProfileMcpPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/mcp${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Agents tab. */
export function getProfileAgentsPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/agents${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Skills tab. */
export function getProfileSkillsPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}/skills${profileContextQuery(organizationId)}` as Href;
}
