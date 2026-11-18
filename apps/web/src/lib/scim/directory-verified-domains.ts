import { WORKOS_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { WorkOS, type Organization } from '@workos-inc/node';
import 'server-only';

/**
 * The domains a WorkOS organization has proven it owns through DNS.
 *
 * Directory sync binds a Kilo account to a directory user's address, which for
 * a pre-existing account means taking that account over. The organization's
 * single `sso_domain` is too narrow for that: an enterprise routinely runs
 * several mail domains through one directory, and only one of them can be the
 * SSO authority (Policy Resolution rules 4 and 6). So the bind is also allowed
 * for any other domain the organization owns — but "owns" has to mean
 * something stronger than "typed into WorkOS".
 *
 * **DNS verification is the bar, not `state === 'verified'` alone.** A domain
 * object carries both `state` and `verification_strategy`, and WorkOS reaches
 * `verified` by either route: a self-serve DNS TXT record, or a `manual` tick
 * in the dashboard — `POST /organizations` even accepts `state: 'verified'`
 * directly. Only `dns` is evidence the customer controls the domain; `manual`
 * is an assertion by whoever had dashboard access. Since this authorizes
 * taking over an existing Kilo account, the weaker signal is not enough.
 *
 * This is deliberately not read from the `dsync.activated` payload. That
 * event's domain objects are `{object, id, domain}` only — no `state`, no
 * `verification_strategy` — so the event cannot distinguish a DNS-verified
 * domain from one pending verification. The Organizations API is the only
 * source that can.
 */

const workos = new WorkOS(WORKOS_API_KEY);

/**
 * Raised when WorkOS could not be asked: a 5xx, a timeout, a transport error,
 * a rejected key. Separate from "the domain is not verified", because the two
 * are not the same answer — a refusal is terminal and parks the event, while
 * an unreachable WorkOS is transient and must hold the caller's cursor so no
 * bind is wrongly refused during an outage.
 */
export class VerifiedDomainLookupError extends Error {}

/**
 * Raised when WorkOS answers 404: the organization behind
 * `organizations.external_org_id` is gone, or the binding is stale.
 *
 * Distinct from `VerifiedDomainLookupError` because it is a *completed*
 * answer. Retrying cannot produce an organization that does not exist, so the
 * caller turns this into a terminal conflict and the event parks — rather than
 * a 500, which the Worker classifies `unavailable` and never parks, holding
 * the one shared cursor and stalling every other directory behind it
 * (`.specs/organization-sso.md`, Directory Sync rule 7).
 */
export class VerifiedDomainOwnerMissingError extends Error {}

/**
 * Lowercased domains the organization has verified through DNS.
 *
 * `workOSOrganizationId` is `organizations.external_org_id`, which directory
 * sync writes when it binds the directory.
 */
export async function listDnsVerifiedDomains(workOSOrganizationId: string): Promise<string[]> {
  let organization: Organization;
  try {
    organization = await workos.organizations.getOrganization(workOSOrganizationId);
  } catch (error) {
    // A 404 is a completed answer, not an outage. The organization is gone, or
    // the binding is stale, and no retry changes that — so it must not become
    // a lookup failure: the caller turns those into a 500, the Worker reads a
    // 5xx as `unavailable`, and that class never parks, which would hold the
    // single shared cursor forever and stall every other directory
    // (`.specs/organization-sso.md`, Directory Sync rule 7).
    if (isNotFound(error)) {
      throw new VerifiedDomainOwnerMissingError(
        `WorkOS organization ${workOSOrganizationId} does not exist`
      );
    }

    // Everything else is outage-shaped: a 5xx, a timeout, a transport error,
    // or a rejected key. Whether this address is allowed is still unknown, so
    // the caller holds its cursor rather than refusing a bind that may be
    // valid.
    throw new VerifiedDomainLookupError(
      `Could not read WorkOS organization ${workOSOrganizationId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // `?? []` because the SDK types `domains` as present but other readers in
  // this repo do not trust that (`organization-sso-router.ts:150,158,182`).
  // Without it an omitted field throws a TypeError, which the caller wraps as
  // a lookup failure and turns into the same un-parkable 500.
  return (organization.domains ?? [])
    .filter(domain => domain.state === 'verified' && domain.verificationStrategy === 'dns')
    .map(domain => domain.domain.trim().toLowerCase())
    .filter(domain => domain !== '');
}

/**
 * WorkOS answers 404 with a `status` on the thrown error. Checked
 * structurally rather than by error class, because the SDK's
 * `NotFoundException` is not exported from its `workerd`-conditioned entry and
 * `organization-sso-router.ts` reads the same field the same way.
 */
function isNotFound(error: unknown): boolean {
  // `in` narrows the property to `unknown`, so the comparison needs no cast.
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}
