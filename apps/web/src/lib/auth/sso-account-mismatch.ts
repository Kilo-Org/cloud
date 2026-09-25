export type SsoAccountMismatch = {
  expectedEmail: string;
  signedInEmail: string;
};

/**
 * Canonical form used to compare an SSO request's expected address with the
 * browser session's address. The mobile app lowercases and trims the draft it
 * sends, so case and surrounding whitespace must not decide the outcome.
 */
export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Detects when an Enterprise SSO request asks for a different account than the
 * one the browser is already signed in as.
 *
 * Returns null (no mismatch) unless the request is an SSO request, the request
 * carries a usable expected address, and the browser session carries a usable
 * signed-in address. An absent/empty `email` or a signed-out visitor keeps the
 * existing behaviour, as does a matching address.
 */
export function detectSsoAccountMismatch(
  params: Record<string, string>,
  signedInEmail: string | null | undefined
): SsoAccountMismatch | null {
  if (params.sso !== 'true' && !params.domain) {
    return null;
  }

  const expectedEmail = normalizeAccountEmail(params.email ?? '');
  if (!expectedEmail) {
    return null;
  }

  const normalizedSignedInEmail = normalizeAccountEmail(signedInEmail ?? '');
  if (!normalizedSignedInEmail) {
    return null;
  }

  if (expectedEmail === normalizedSignedInEmail) {
    return null;
  }

  return { expectedEmail, signedInEmail: normalizedSignedInEmail };
}
