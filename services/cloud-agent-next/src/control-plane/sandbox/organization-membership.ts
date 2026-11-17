import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { getPgDb } from '../../db/pg.js';
import type { Env } from '../../types.js';

/** Current membership of one user in one organization, read on every issuance. */
export type OrganizationMembershipReader = (
  userId: string,
  organizationId: string
) => Promise<boolean>;

/** The Worker's direct-membership read; Durable Objects resolve it through Hyperdrive. */
export function workerOrganizationMembershipReader(
  env: Pick<Env, 'HYPERDRIVE'>
): OrganizationMembershipReader {
  return (userId, organizationId) =>
    hasOrganizationAccess(getPgDb(env), { kiloUserId: userId, organizationId });
}

/** The session owner left the organization, so no organization-attributed grant is due. */
export class OrganizationAccessRevokedError extends Error {
  constructor() {
    super('Session owner is no longer a member of the organization');
    this.name = 'OrganizationAccessRevokedError';
  }
}

/** The membership read did not answer, so the grant is denied rather than assumed. */
export class OrganizationMembershipUnavailableError extends Error {
  constructor() {
    super('Organization membership could not be read');
    this.name = 'OrganizationMembershipUnavailableError';
  }
}
