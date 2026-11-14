import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';

/** The membership row a scope title needs: the scope's id and the name to paint. */
export type ScopeOrganization = { organizationId: string; organizationName: string };

/** The labels a missing scope name falls back to. */
type ScopeTitleLabels = { personal: string; organization: string };

/**
 * The name the membership list carries for a scope, or undefined when it names
 * none (not a member, not loaded yet, or the personal scope). The title rule
 * and the screens that remember the name share this one lookup.
 */
export function reviewerScopeMembershipName(
  scope: string,
  organizations: readonly ScopeOrganization[] | undefined
): string | undefined {
  if (scope === PERSONAL_SCOPE) {
    return undefined;
  }
  return organizations?.find(org => org.organizationId === scope)?.organizationName;
}

/**
 * The scope a Code Reviewer screen acts on, as its header title: the
 * organization's name for an organization scope, `Personal` for the personal
 * one. A reader who belongs to several organizations can then tell whose
 * reviews, platform status, or settings the screen acts on.
 *
 * Until the membership list names the scope the title keeps a stand-in instead
 * of disappearing: the header holds its line, so the body below never moves
 * when the name arrives.
 *
 * The remembered name sits in the middle of the order: the membership list is
 * the live truth while the reader can open the scope, and once access is lost
 * that list stops naming it — the last name this app painted is then the only
 * one left, and it still beats the generic label. It is read for this scope id
 * alone, so one organization's remembered name can never title another's
 * screen.
 */
// eslint-disable-next-line max-params -- the scope, its membership rows, the label fallbacks and the remembered name are the title rule's inputs
export function reviewerScopeTitle(
  scope: string,
  organizations: readonly ScopeOrganization[] | undefined,
  labels: ScopeTitleLabels,
  knownName?: string
): string {
  if (scope === PERSONAL_SCOPE) {
    return labels.personal;
  }
  return reviewerScopeMembershipName(scope, organizations) ?? knownName ?? labels.organization;
}
