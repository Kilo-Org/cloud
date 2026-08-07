import { API_BASE_URL } from '@/lib/config';
import { clearAttestKeyOnRefusal } from '@/lib/auth/admission';
import { parseAuthErrorCode } from '@/lib/auth/native-auth-contract';

/**
 * Minimal fetch helper for auth endpoints. Returns success with parsed body
 * or failure with an optional error code.
 *
 * Every native auth POST routes through here, so this is also where a refused
 * admission drops the stored App Attest key id. Putting it here rather than at
 * each caller means a new sign-in path cannot forget it.
 */
export async function postAuth(
  path: string,
  body: unknown
): Promise<{ ok: true; data: unknown } | { ok: false; errorCode: string | undefined }> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const errorCode = parseAuthErrorCode(json);
      await clearAttestKeyOnRefusal(errorCode);
      return { ok: false, errorCode };
    }

    return { ok: true, data: json };
  } catch {
    return { ok: false, errorCode: undefined };
  }
}

export function hasStringCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}
