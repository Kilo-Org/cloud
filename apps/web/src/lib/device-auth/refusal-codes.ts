/**
 * The refusal contract of the device-auth surfaces: the stable codes and the
 * copy that goes with each one.
 *
 * This module carries no server-only dependency, because the approval page is a
 * client component and must read the same codes the server refuses with. A code
 * never changes meaning; copy is carried separately.
 */
export const DEVICE_AUTH_REFUSAL_CODES = {
  /** The body named a `requesting_client` that fails its schema. */
  invalidRequestingClient: 'INVALID_REQUESTING_CLIENT',
  /** The request carried a pending-link secret that matches no live link. */
  pendingLinkExpired: 'PENDING_LINK_EXPIRED',
  /** Too many live pending requests from one address. */
  rateLimited: 'RATE_LIMITED',
  /** The body had content, but it is not the JSON pairing request it claims. */
  invalidRequestBody: 'INVALID_REQUEST_BODY',
  /** The body carried a `pendingLinkToken` that fails its schema. */
  pendingLinkInvalid: 'PENDING_LINK_INVALID',
  /** No request is stored under the code the caller presented. */
  requestNotFound: 'REQUEST_NOT_FOUND',
  /** The request is no longer pending, so it cannot change state again. */
  requestNotPending: 'REQUEST_NOT_PENDING',
  /** The request reached its deadline before the caller acted. */
  requestExpired: 'REQUEST_EXPIRED',
  /** The approval did not confirm the client the request names. */
  clientConfirmationMismatch: 'CLIENT_CONFIRMATION_MISMATCH',
  /** The approval for a request carrying a live pending link chose nothing. */
  pendingLinkChoiceRequired: 'PENDING_LINK_CHOICE_REQUIRED',
} as const;

export type DeviceAuthRefusalCode =
  (typeof DEVICE_AUTH_REFUSAL_CODES)[keyof typeof DEVICE_AUTH_REFUSAL_CODES];

/** The rate-limit copy, which is also the `RATE_LIMITED` refusal's copy. */
export const DEVICE_AUTH_PENDING_LIMIT_MESSAGE =
  'Too many sign-in attempts from this network. Try again later.';

/**
 * The one copy for each refusal, so a route body and the approval page cannot
 * drift apart. Every string says what happened and what to do next.
 */
const REFUSAL_COPY: Readonly<Record<DeviceAuthRefusalCode, string>> = {
  [DEVICE_AUTH_REFUSAL_CODES.invalidRequestingClient]: 'Invalid requesting client',
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkExpired]:
    'This sign-in link has expired. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.rateLimited]: DEVICE_AUTH_PENDING_LIMIT_MESSAGE,
  [DEVICE_AUTH_REFUSAL_CODES.invalidRequestBody]:
    'This sign-in request could not be read. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkInvalid]:
    'This sign-in link could not be read. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.requestNotFound]:
    'This sign-in request was not found. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.requestNotPending]:
    'This sign-in request can no longer be used. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.requestExpired]:
    'This sign-in request has expired. Start the sign-in again.',
  [DEVICE_AUTH_REFUSAL_CODES.clientConfirmationMismatch]:
    'Confirm the app named in this request before approving it.',
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkChoiceRequired]:
    'Choose whether to add the sign-in method before approving.',
};

const copyByCode = new Map<string, string>(Object.entries(REFUSAL_COPY));

/** The copy for a refusal code, or undefined for a code this version does not know. */
export function deviceAuthRefusalCopy(code: string): string | undefined {
  return copyByCode.get(code);
}

/** The copy that travels with a refusal this build produces. */
export function refusalCopyFor(code: DeviceAuthRefusalCode): string {
  return REFUSAL_COPY[code];
}
