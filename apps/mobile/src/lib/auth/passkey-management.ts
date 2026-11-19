import * as z from 'zod';

import { buildAuthHeaders } from '@/lib/auth/auth-header';
import { postAuth } from '@/lib/auth/auth-fetch';
import { parseEmailCodeResponse } from '@/lib/auth/native-auth-contract';
import { resolveAdmission } from '@/lib/auth/resolve-admission';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';

/** The route that exchanges fresh primary proof for a management authorization. */
const AUTHORIZE_ROUTE = '/api/auth/passkey/management/authorize';
/** Leg 1: bind a pending SSO approval request to this native session. */
const SSO_START_ROUTE = '/api/auth/passkey/management/sso/start';
/** Leg 2: collect the grant once the browser leg has approved. */
const SSO_COLLECT_ROUTE = '/api/auth/passkey/management/sso/collect';

/**
 * What a management authorization is minted for. The server binds each
 * authorization to one operation, so an enrollment proof can never rename or
 * remove a credential, and the reverse.
 */
export type PasskeyManagementOperation = 'enroll' | 'rename' | 'remove';

const authorizationSchema = z.object({
  authorization: z.string().min(1),
  expiresIn: z.number().positive(),
});

/**
 * Why fresh primary proof was not accepted.
 *
 * - `device-unsupported`: this bearer cannot manage passkeys at all (an API
 *   key, a CLI or device-auth credential). No in-app step fixes it.
 * - `invalid-code`: the emailed code was wrong, expired, or belongs to another
 *   account. The panel keeps the challenge and asks for a new code.
 * - `invalid-ticket`: the passkey assertion expired, was already used, or
 *   belongs to another account. A new assertion is the retry.
 * - `in-progress`: another request holds the code's reservation; the same code
 *   can be submitted again shortly.
 * - `too-many-attempts`: the code's attempt budget is spent; a new code is
 *   required.
 * - `sso-required`: the account's domain requires single sign-on, so the
 *   browser approval is the proof it accepts.
 * - `session-ended`: the bearer itself was refused.
 * - `admission-required`: the device proof was missing; the app retries the
 *   admission challenge.
 * - `retryable`: the request never reached the server, or the server said it
 *   could not answer now.
 * - `failed`: a refusal this client does not recognize as retryable.
 */
export type ManagementProofFailure =
  | 'device-unsupported'
  | 'invalid-code'
  | 'invalid-ticket'
  | 'in-progress'
  | 'too-many-attempts'
  | 'sso-required'
  | 'session-ended'
  | 'admission-required'
  | 'retryable'
  | 'failed';

/** A fresh proof that the server accepted, and the moment it stops being usable. */
type ManagementAuthorization = {
  authorization: string;
  expiresAtMs: number;
};

export type ManagementAuthorizationResult =
  | ({ status: 'authorized' } & ManagementAuthorization)
  | {
      status: 'error';
      failure: ManagementProofFailure;
      /** The failure already showed its own message; the panel must not repeat it. */
      reported?: boolean;
    };

export type ManagementCodeRequestResult =
  | { status: 'sent'; challengeId: string }
  | { status: 'error'; failure: ManagementProofFailure };

function proofFailure(
  errorCode: string | undefined,
  httpStatus?: number,
  ssoOrganizationId?: string
): ManagementProofFailure {
  switch (errorCode) {
    case undefined: {
      // The request never reached the server, or its answer was not one this
      // client parses: both are retried by asking again.
      return 'retryable';
    }
    case 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED': {
      return 'device-unsupported';
    }
    case 'INVALID_CODE': {
      return 'invalid-code';
    }
    case 'INVALID_TICKET': {
      return 'invalid-ticket';
    }
    case 'CODE_IN_PROGRESS': {
      return 'in-progress';
    }
    case 'TOO_MANY_ATTEMPTS': {
      return 'too-many-attempts';
    }
    case 'ADMISSION_REQUIRED': {
      return 'admission-required';
    }
    case 'SSO_ERROR': {
      // The account's domain refused this proof. Only a 403 that names the
      // organization requiring SSO is the browser handoff: a 503 is that
      // domain's SSO policy or provider being unreachable right now, and the
      // approval page would fail the same way, so asking again is the retry.
      return httpStatus === 403 && ssoOrganizationId !== undefined ? 'sso-required' : 'retryable';
    }
    case 'UNAUTHORIZED':
    case 'Unauthorized': {
      return 'session-ended';
    }
    default: {
      // A named refusal the client does not know is left to the generic failure.
      return 'failed';
    }
  }
}

/**
 * Mint the authorization the management routes require, from one proof body.
 * The bearer identifies the device session the authorization is bound to; the
 * proof identifies the person. Both must resolve to the same account.
 */
async function mintAuthorization(
  body: Record<string, unknown>
): Promise<ManagementAuthorizationResult> {
  let admissionBody: Record<string, unknown> = {};
  try {
    admissionBody = await resolveAdmission();
  } catch {
    // resolveAdmission has already shown the retryable admission message.
    return { status: 'error', failure: 'retryable', reported: true };
  }

  const headers = buildAuthHeaders(await getAuthTokenForRequest());
  const result = await postAuth(AUTHORIZE_ROUTE, { ...body, ...admissionBody }, headers);
  if (!result.ok) {
    return {
      status: 'error',
      failure: proofFailure(result.errorCode, result.httpStatus, result.ssoOrganizationId),
    };
  }
  const parsed = authorizationSchema.safeParse(result.data);
  if (!parsed.success) {
    return { status: 'error', failure: 'retryable' };
  }
  return {
    status: 'authorized',
    authorization: parsed.data.authorization,
    expiresAtMs: Date.now() + parsed.data.expiresIn * 1000,
  };
}

/**
 * Send a sign-in code to the account's own address, for the email proof. The
 * code is the person's primary credential at the address the account already
 * owns; the reuse of the sign-in route keeps one delivery path, one expiry and
 * one attempt budget for both signing in and managing passkeys.
 */
export async function requestManagementCode(email: string): Promise<ManagementCodeRequestResult> {
  const result = await postAuth('/api/auth/native/otp', { email });
  if (!result.ok) {
    if (result.errorCode === 'TOO_MANY_ATTEMPTS' || result.errorCode === 'RATE_LIMITED') {
      return { status: 'error', failure: 'too-many-attempts' };
    }
    // A send failure has two answers the panel acts on: the domain needs the
    // browser approval, or nothing changed and the same choice can be repeated.
    const failure = proofFailure(result.errorCode, result.httpStatus, result.ssoOrganizationId);
    return {
      status: 'error',
      failure: failure === 'sso-required' || failure === 'failed' ? failure : 'retryable',
    };
  }
  const parsed = parseEmailCodeResponse(result.data);
  if (!parsed?.challengeId) {
    return { status: 'error', failure: 'retryable' };
  }
  return { status: 'sent', challengeId: parsed.challengeId };
}

/** Mint an authorization from an emailed sign-in code the person typed in. */
export function authorizePasskeyManagementWithCode(params: {
  operation: PasskeyManagementOperation;
  email: string;
  code: string;
  challengeId: string;
}): Promise<ManagementAuthorizationResult> {
  return mintAuthorization({
    proof: 'email',
    operation: params.operation,
    email: params.email,
    code: params.code,
    challengeId: params.challengeId,
  });
}

/** Mint an authorization from a passkey assertion. The ticket comes from the
 * authentication ceremony's verify step, which proves a live primary sign-in
 * without redeeming the session the person is already using.
 */
export function authorizePasskeyManagementWithTicket(params: {
  operation: PasskeyManagementOperation;
  ticket: string;
}): Promise<ManagementAuthorizationResult> {
  return mintAuthorization({
    proof: 'passkey',
    operation: params.operation,
    ticket: params.ticket,
  });
}

const ssoStartSchema = z.object({
  requestId: z.string().min(1),
  approvalUrl: z.string().url(),
  expiresIn: z.number().positive(),
});

const ssoGrantSchema = z.object({
  authorization: z.string().min(1),
  expiresIn: z.number().positive(),
});

/** Why the SSO approval could not be started or collected. */
export type SsoApprovalFailure =
  /** Expired, cancelled, already collected, or bound to another session/account. */
  | 'expired'
  | 'sso-not-required'
  | 'device-unsupported'
  | 'session-ended'
  | 'admission-required'
  | 'blocked'
  | 'sso-unavailable'
  | 'retryable';

export type SsoApprovalStart =
  | {
      status: 'approval-required';
      requestId: string;
      approvalUrl: string;
      expiresAtMs: number;
    }
  | { status: 'error'; failure: SsoApprovalFailure | 'reported' };

export type SsoApprovalCollect =
  | { status: 'authorized'; authorization: string; expiresAtMs: number }
  | { status: 'pending' }
  | { status: 'error'; failure: SsoApprovalFailure };

function ssoFailure(errorCode: string | undefined): SsoApprovalFailure {
  switch (errorCode) {
    case undefined: {
      // The request never reached the server, or its answer was not one this
      // client parses.
      return 'retryable';
    }
    case 'SSO_APPROVAL_INVALID': {
      return 'expired';
    }
    case 'SSO_NOT_REQUIRED': {
      return 'sso-not-required';
    }
    case 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED': {
      return 'device-unsupported';
    }
    case 'UNAUTHORIZED':
    case 'Unauthorized': {
      return 'session-ended';
    }
    case 'ADMISSION_REQUIRED': {
      return 'admission-required';
    }
    case 'BLOCKED': {
      return 'blocked';
    }
    case 'SSO_ERROR': {
      return 'sso-unavailable';
    }
    default: {
      // An unknown refusal and a request that never reached the server are both
      // retried by asking again.
      return 'retryable';
    }
  }
}

/**
 * Start the SSO primary-verification handoff: bind a request to this native
 * session, the operation, and the device admission, and get the page the person
 * approves in the OS browser. Approval happens on the web with the account's own
 * SSO session; the app never receives a management grant in a URL.
 */
export async function startPasskeyManagementSso(params: {
  operation: PasskeyManagementOperation;
}): Promise<SsoApprovalStart> {
  let admissionBody: Record<string, unknown> = {};
  try {
    admissionBody = await resolveAdmission();
  } catch {
    // resolveAdmission has already shown the retryable admission message.
    return { status: 'error', failure: 'reported' };
  }
  const headers = buildAuthHeaders(await getAuthTokenForRequest());
  const result = await postAuth(
    SSO_START_ROUTE,
    { operation: params.operation, ...admissionBody },
    headers
  );
  if (!result.ok) {
    return { status: 'error', failure: ssoFailure(result.errorCode) };
  }
  const parsed = ssoStartSchema.safeParse(result.data);
  if (!parsed.success) {
    return { status: 'error', failure: 'retryable' };
  }
  return {
    status: 'approval-required',
    requestId: parsed.data.requestId,
    approvalUrl: parsed.data.approvalUrl,
    expiresAtMs: Date.now() + parsed.data.expiresIn * 1000,
  };
}

/**
 * Ask once whether the browser leg has approved the pending request. A pending
 * answer is not a refusal: the caller keeps polling until the window ends. The
 * device proof was verified when the request started, so the poll carries the
 * request id and the bearer only.
 */
export async function collectPasskeyManagementSso(params: {
  requestId: string;
}): Promise<SsoApprovalCollect> {
  const headers = buildAuthHeaders(await getAuthTokenForRequest());
  const result = await postAuth(SSO_COLLECT_ROUTE, { requestId: params.requestId }, headers);
  if (!result.ok) {
    if (result.errorCode === 'SSO_APPROVAL_PENDING' || result.httpStatus === 425) {
      return { status: 'pending' };
    }
    return { status: 'error', failure: ssoFailure(result.errorCode) };
  }
  const parsed = ssoGrantSchema.safeParse(result.data);
  if (!parsed.success) {
    return { status: 'error', failure: 'retryable' };
  }
  return {
    status: 'authorized',
    authorization: parsed.data.authorization,
    expiresAtMs: Date.now() + parsed.data.expiresIn * 1000,
  };
}
