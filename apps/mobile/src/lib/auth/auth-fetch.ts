import { z } from 'zod';

import { API_BASE_URL } from '@/lib/config';
import { clearAttestKeyOnRefusal } from '@/lib/auth/admission';
import { parseAuthError } from '@/lib/auth/native-auth-contract';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';

const stringCodeErrorSchema = z.object({ code: z.string() });

/**
 * Minimal fetch helper for auth endpoints. Returns success with parsed body
 * or failure with an optional error code and SSO organization id.
 *
 * Every native auth POST routes through here, so this is also where a refused
 * admission drops the stored App Attest key id. Putting it here rather than at
 * each caller means a new sign-in path cannot forget it.
 */
export async function postAuth(
  path: string,
  body: unknown
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; errorCode: string | undefined; ssoOrganizationId: string | undefined }
> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildClientMetadataHeaders() },
      body: JSON.stringify(body),
    });

    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const parsed = parseAuthError(json);
      await clearAttestKeyOnRefusal(parsed?.code);
      return { ok: false, errorCode: parsed?.code, ssoOrganizationId: parsed?.ssoOrganizationId };
    }

    return { ok: true, data: json };
  } catch {
    return { ok: false, errorCode: undefined, ssoOrganizationId: undefined };
  }
}

export function hasStringCode(error: unknown): error is { code: string } {
  return stringCodeErrorSchema.safeParse(error).success;
}
