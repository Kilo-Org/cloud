import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type Href } from 'expo-router';

type ProfileOrganization = { organizationId: string };

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
export function getProfilesPath(): Href {
  return '/(app)/(tabs)/(3_profile)/profiles' as Href;
}

/** The repo-to-profile default bindings screen. */
export function getRepoBindingsPath(organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/repo-bindings${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Overview tab (the profile's own route). */
export function getProfileOverviewPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Variables tab. */
export function getProfileVariablesPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/variables${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Setup Commands tab. */
export function getProfileCommandsPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/commands${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Slash Commands tab. */
export function getProfileSlashCommandsPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/slash-commands${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's MCP Servers tab. */
export function getProfileMcpPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/mcp${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Agents tab. */
export function getProfileAgentsPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/agents${profileContextQuery(organizationId)}` as Href;
}

/** The profile editor's Skills tab. */
export function getProfileSkillsPath(profileId: string, organizationId?: string): Href {
  return `/(app)/(tabs)/(3_profile)/profiles/${profileId}/skills${profileContextQuery(organizationId)}` as Href;
}
