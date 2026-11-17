import 'server-only';

import { STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';

import {
  readPasskeyManagementSsoRequestForApproval,
  type PasskeyManagementOperation,
} from './passkey-management';

/**
 * What the browser half of an SSO management proof may show, decided from the
 * pending request and the reader's own session. Every `ok: false` state names
 * the one thing the reader can do about it, and the approval POST re-derives
 * this same answer before it writes anything.
 */
export type PasskeyManagementApprovalState =
  | {
      status: 'ready';
      requestId: string;
      operation: PasskeyManagementOperation;
      accountEmail: string;
      requiredOrganizationId: string;
    }
  | { status: 'expired' }
  | { status: 'sign_in' }
  /**
   * The browser already approved this request for the reader's own account.
   * This comes from the stored row, never from a query flag, so a crafted
   * `?status=approved` cannot claim an approval that did not happen.
   */
  | { status: 'approved'; operation: PasskeyManagementOperation; accountEmail: string }
  /**
   * The reader's session belongs to someone else. Only the reader's own address
   * is named: the request id is public, so the owning account's address must
   * not be disclosed to whoever holds the link.
   */
  | { status: 'wrong_account'; signedInEmail: string }
  | { status: 'stale' }
  | { status: 'sso_required' }
  | { status: 'organization_not_required' };

export type PasskeyManagementApprovalSession = {
  userId: string;
  email: string;
  /** Unix seconds when this browser session signed in. */
  authenticatedAt?: number;
  /** WorkOS organization this session authenticated through, when it used SSO. */
  ssoSourceOrganizationId?: string;
};

export async function evaluatePasskeyManagementApproval(params: {
  requestId: string;
  session: PasskeyManagementApprovalSession | null;
}): Promise<PasskeyManagementApprovalState> {
  const request = await readPasskeyManagementSsoRequestForApproval(params.requestId);
  if (!request) {
    return { status: 'expired' };
  }

  const owner = await findUserById(request.userId);
  if (!owner) {
    return { status: 'expired' };
  }
  // Account recovery rotates the pepper, which invalidates the request in the
  // write path. Report the same answer here so the page never offers a form
  // whose approval writes nothing.
  if ((request.webSessionPepper ?? null) !== (owner.web_session_pepper ?? null)) {
    return { status: 'expired' };
  }

  if (!params.session) {
    return { status: 'sign_in' };
  }
  if (params.session.userId !== request.userId) {
    return { status: 'wrong_account', signedInEmail: params.session.email };
  }

  // The row, not the redirect, decides what happened: anything past `pending`
  // was approved by this account already, and the app collects it.
  if (request.state !== 'pending') {
    return {
      status: 'approved',
      operation: request.operation,
      accountEmail: owner.google_user_email,
    };
  }

  // The account's domain must still require the organization the request was
  // started for. A policy change between the two legs refuses the approval
  // rather than approving under an organization that no longer governs it.
  const domain = getLowerDomainFromEmail(owner.google_user_email);
  const authority = domain
    ? await resolveSsoAuthorityForDomain(domain)
    : ({ status: 'not_required' } as const);
  if (
    authority.status !== 'required' ||
    !request.ssoOrganizationId ||
    authority.sourceOrganizationId !== request.ssoOrganizationId
  ) {
    return { status: 'organization_not_required' };
  }

  const signedInAt = params.session.authenticatedAt;
  if (
    typeof signedInAt !== 'number' ||
    Date.now() - signedInAt * 1000 > STEP_UP_ENROLLMENT_FRESH_SIGNIN_MS
  ) {
    return { status: 'stale' };
  }

  if (params.session.ssoSourceOrganizationId !== request.ssoOrganizationId) {
    return { status: 'sso_required' };
  }

  return {
    status: 'ready',
    requestId: params.requestId,
    operation: request.operation,
    accountEmail: owner.google_user_email,
    requiredOrganizationId: request.ssoOrganizationId,
  };
}
