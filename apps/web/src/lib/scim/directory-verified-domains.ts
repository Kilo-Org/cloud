import { WORKOS_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { WorkOS } from '@workos-inc/node';
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
 * Raised when WorkOS could not be asked. Separate from "the domain is not
 * verified", because the two are not the same answer: a refusal is terminal
 * and parks the event, while an unreachable WorkOS is transient and must hold
 * the caller's cursor so no bind is wrongly refused during an outage.
 */
export class VerifiedDomainLookupError extends Error {}

/**
 * Lowercased domains the organization has verified through DNS.
 *
 * `workOSOrganizationId` is `organizations.external_org_id`, which directory
 * sync writes when it binds the directory.
 */
export async function listDnsVerifiedDomains(workOSOrganizationId: string): Promise<string[]> {
  let organization;
  try {
    organization = await workos.organizations.getOrganization(workOSOrganizationId);
  } catch (error) {
    // Includes the 404 for an organization that no longer exists. Even that is
    // reported as a lookup failure rather than an empty set: answering "no
    // verified domains" would refuse the bind terminally and park the event,
    // and a deleted WorkOS organization is an operator problem rather than a
    // statement about this address.
    throw new VerifiedDomainLookupError(
      `Could not read WorkOS organization ${workOSOrganizationId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return organization.domains
    .filter(domain => domain.state === 'verified' && domain.verificationStrategy === 'dns')
    .map(domain => domain.domain.trim().toLowerCase())
    .filter(domain => domain !== '');
}
