import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/** Stable fixture name prefix: every org this topic has ever created. */
export const W4C_ORG_PAIR_NAME_PREFIX = '[seed:w4c-org-pair]';

/**
 * The fixture org name embeds the owner email, the stable key across harness
 * runs (the member email changes). Building the name in one place keeps the
 * insert and the cleanup predicate in agreement.
 */
export function w4cOrgPairName(ownerEmail: string): string {
  return `${W4C_ORG_PAIR_NAME_PREFIX} ${ownerEmail}`;
}

/**
 * Selects this fixture's previously created organizations for one owner. The
 * org name already embeds the owner email, so scoping to the full name keeps
 * reruns idempotent for that owner without deleting fixture orgs seeded for a
 * different owner against the same dev DB.
 */
export function w4cOrgPairCleanupPredicate(ownerEmail: string) {
  return eq(organizations.name, w4cOrgPairName(ownerEmail));
}
