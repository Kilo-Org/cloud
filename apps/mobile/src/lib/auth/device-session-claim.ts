/**
 * Extracts the `deviceSessionId` claim from an access token's JWT payload.
 *
 * The claim identifies the server device session that the token was issued
 * for, so sign-out can revoke exactly that session. A missing claim or any
 * malformed/undecodable token returns null — callers treat null as "nothing
 * actionable on the session id" and rely on the server-side
 * `revokeCurrentDeviceSession` outcome instead.
 */
export function deviceSessionIdFromToken(token: string): string | null {
  try {
    const segments = token.split('.');
    const payload = segments[1];
    if (!payload) {
      return null;
    }

    // JWT payloads are base64url-encoded. Convert to standard base64 (restore
    // padding) and decode. Hermes provides `atob`; the payload is UTF-8-safe
    // JSON, so decode percent-escaped bytes to rebuild the original string.
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    // Percent-escape each decoded byte so decodeURIComponent can rebuild the
    // UTF-8 payload string.
    let escaped = '';
    for (const char of atob(padded)) {
      escaped += `%${`00${(char.codePointAt(0) ?? 0).toString(16)}`.slice(-2)}`;
    }
    const json = decodeURIComponent(escaped);

    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const claim = (parsed as { deviceSessionId?: unknown }).deviceSessionId;
    return typeof claim === 'string' && claim.length > 0 ? claim : null;
  } catch {
    return null;
  }
}
