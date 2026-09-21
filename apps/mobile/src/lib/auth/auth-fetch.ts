import { z } from 'zod';

import { API_BASE_URL } from '@/lib/config';
import { clearAttestKeyOnRefusal } from '@/lib/auth/admission';
import { parseAuthError } from '@/lib/auth/native-auth-contract';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';

const stringCodeErrorSchema = z.object({ code: z.string() });

/**
 * Upper bound on every auth POST. A hung request must reject so the caller's
 * `finally { finishAction(...) }` always clears the busy state; without it a
 * single stuck POST leaves the sign-in control dead for the life of the app.
 */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Minimal fetch helper for auth endpoints. Returns success with parsed body
 * or failure with an optional error code and SSO organization id.
 *
 * Every native auth POST routes through here, so this is also where a refused
 * admission drops the stored App Attest key id. Putting it here rather than at
 * each caller means a new sign-in path cannot forget it.
 *
 * `extraHeaders` carries a caller's own auth header; the login routes take
 * none, and only the authenticated passkey registration route sets it.
 */
export async function postAuth(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; errorCode: string | undefined; ssoOrganizationId: string | undefined }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildClientMetadataHeaders(),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch (error) {
      // An abort also lands here when the server sent headers but stalled the
      // body, so a failed parse must not swallow the timeout: rethrow so the
      // outer catch names it TIMEOUT instead of reporting an empty success.
      if (controller.signal.aborted) {
        throw error;
      }
      json = undefined;
    }

    if (!response.ok) {
      const parsed = parseAuthError(json);
      await clearAttestKeyOnRefusal(parsed?.code);
      return { ok: false, errorCode: parsed?.code, ssoOrganizationId: parsed?.ssoOrganizationId };
    }

    return { ok: true, data: json };
  } catch {
    // A real abort is named so the caller can show the timeout copy; any other
    // network failure stays undefined and keeps the generic message. Only a
    // server refusal drops the attest key, so the abort path must not touch it.
    return {
      ok: false,
      errorCode: controller.signal.aborted ? 'TIMEOUT' : undefined,
      ssoOrganizationId: undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function hasStringCode(error: unknown): error is { code: string } {
  return stringCodeErrorSchema.safeParse(error).success;
}
