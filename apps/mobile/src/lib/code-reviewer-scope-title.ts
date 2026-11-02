import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';

/** The membership row a scope title needs: the scope's id and the name to paint. */
type ScopeOrganization = { organizationId: string; organizationName: string };

/** The labels a missing scope name falls back to. */
type ScopeTitleLabels = { personal: string; organization: string };

/**
 * The scope a Code Reviewer screen acts on, as its header title: the
 * organization's name for an organization scope, `Personal` for the personal
 * one. A reader who belongs to several organizations can then tell whose
 * reviews, platform status, or settings the screen acts on.
 *
 * Until the membership list names the scope the title keeps the generic
 * `Organization` label instead of disappearing: the header holds its line, so
 * the body below never moves when the name arrives.
 */
export function reviewerScopeTitle(
  scope: string,
  organizations: readonly ScopeOrganization[] | undefined,
  labels: ScopeTitleLabels
): string {
  if (scope === PERSONAL_SCOPE) {
    return labels.personal;
  }
  return (
    organizations?.find(org => org.organizationId === scope)?.organizationName ??
    labels.organization
  );
}
