import { createHash } from 'node:crypto';

import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/** Stable fixture name prefix: every org this topic created before it moved to a user-facing name. */
export const W4C_ORG_PAIR_NAME_PREFIX = '[seed:w4c-org-pair]';

/** Namespace for the fixture's deterministic organization id; never reused elsewhere. */
const W4C_ORG_PAIR_ID_NAMESPACE = 'dev-seed:w4c-org-pair';

/**
 * The fixture org name embeds the owner email, the stable key across harness
 * runs (the member email changes). Building the name in one place keeps the
 * insert and the cleanup predicate in agreement.
 */
export function w4cOrgPairName(ownerEmail: string): string {
  return `${W4C_ORG_PAIR_NAME_PREFIX} ${ownerEmail}`;
}

/**
 * Fixture-specific organization id for one owner, derived from the owner email
 * (RFC 4122 version 5, SHA-1 name-based). The stable primary key lets cleanup
 * delete exactly this fixture's row on a rerun; nothing derives identity from
 * the org's display name, so an ordinary organization that happens to share
 * the same name is never selected. The owner email is the stable key across
 * harness runs.
 */
export function w4cOrgPairOrganizationId(ownerEmail: string): string {
  const hex = createHash('sha1').update(`${W4C_ORG_PAIR_ID_NAMESPACE}:${ownerEmail}`).digest('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Selects the organizations this fixture created before the display name became
 * user-facing for one owner. The legacy name embeds the owner email under the
 * fixture prefix, so scoping to the full name keeps reruns idempotent for that
 * owner without deleting fixture orgs seeded for a different owner against the
 * same dev DB. It never matches a display name the app could hand an ordinary
 * organization.
 */
export function w4cOrgPairCleanupPredicate(ownerEmail: string) {
  return eq(organizations.name, w4cOrgPairName(ownerEmail));
}
