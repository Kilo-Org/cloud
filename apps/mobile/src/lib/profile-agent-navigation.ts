import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

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

export function getProfileAgentScope(
  selectedOrganizationId: string | null,
  organizations: readonly ProfileOrganization[] | undefined,
  organizationsRefreshing = false
): string | undefined {
  if (!selectedOrganizationId) {
    return PERSONAL_SECURITY_SCOPE;
  }
  if (!organizations || organizationsRefreshing) {
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

export function getPrReviewEntryPath(): Href {
  return '/(app)/pr-review' as Href;
}

/**
 * Profile context carried by a profile route. Org-owned profiles travel with
 * their `organizationId`; a personal profile has none, exactly like the tRPC
 * `agentProfiles.*` inputs.
 */
function profileContextQuery(organizationId?: string): string {
  return organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
}

/** The Manage Profiles entry on the Profile tab. */
export function getProfilesPath(stack: ProfileManagementStack = 'profileTab'): Href {
  return PROFILE_ROOTS[stack] as Href;
}

/** The repo-to-profile default bindings screen. */
export function getRepoBindingsPath(
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/repo-bindings${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's create screen. */
export function getNewProfilePath(stack: ProfileManagementStack = 'profileTab'): Href {
  return `${PROFILE_ROOTS[stack]}/new` as Href;
}

/** The profile editor's Overview tab (the profile's own route). */
export function getProfileOverviewPath(
  profileId: string,
  organizationId?: string,
  stack: ProfileManagementStack = 'profileTab'
): Href {
  return `${PROFILE_ROOTS[stack]}/${profileId}${profileContextQuery(organizationId)}` as Href;
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
