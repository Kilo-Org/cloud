import { z } from 'zod';
import type { IdentityStore } from '../db/client';

/**
 * The authority check behind the legacy bridge's SSO provenance and the browser replies'
 * `sso_app_organization` (design 5.8). The web app verified a WorkOS sign-in server-side and names
 * its connection and organization; UTS accepts them only when its own authority data (the
 * `sso-organization` and `membership` syncs) maps that connection to that WorkOS organization,
 * whose `externalId` is an app organization, and the active account holds an active membership
 * there. Nothing is taken from a cookie claim.
 *
 * * `verified`: the app organization the sign-in counts for.
 * * `unverified`: any check failed; the caller goes on without SSO provenance and the field stays
 *   absent. A store failure throws, and the caller decides (the bridge answers 503).
 */
export type SsoAuthorityResult =
  | { status: 'verified'; appOrganizationId: string }
  | { status: 'unverified' };

export type SsoAuthorityCheck = (input: {
  subject: string;
  workosConnectionId: string;
  workosOrganizationId: string;
}) => Promise<SsoAuthorityResult>;

const RowSchema = z.object({ org_id: z.uuid().nullable() });

/** The check as one statement on one identity-store connection (`uts.sso_app_organization`). */
export function identityStoreSsoAuthority(store: IdentityStore): SsoAuthorityCheck {
  return async input => {
    const row = await store.maybeOne(
      {
        text: 'SELECT uts.sso_app_organization($1, $2, $3) AS org_id',
        values: [input.subject, input.workosConnectionId, input.workosOrganizationId],
      },
      RowSchema
    );
    return row === null || row.org_id === null
      ? { status: 'unverified' }
      : { status: 'verified', appOrganizationId: row.org_id };
  };
}
