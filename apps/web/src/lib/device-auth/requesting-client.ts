import { z } from 'zod';

/**
 * The OAuth client a device-auth request asks to connect, as the requester
 * describes it and as the approval page shows it. The approval applies to this
 * exact client: the page displays it, the approver confirms it, and the
 * requester receives an approved pairing only for the client it named.
 */
export type RequestingClient = {
  clientId: string;
  clientName: string;
  redirectOrigin: string;
};

/** Longest value accepted for any displayed client field. */
export const REQUESTING_CLIENT_FIELD_MAX = 200;

/**
 * A value rendered as text on the approval page: bounded, and free of control
 * characters so it cannot break a line or a shell-style record.
 */
const displayField = z
  .string()
  .trim()
  .min(1)
  .max(REQUESTING_CLIENT_FIELD_MAX)
  .refine(value => !/\p{Cc}/u.test(value), 'must not contain control characters');

/**
 * An absolute origin: `scheme://host[:port]` for a web redirect, or a bare
 * `scheme:` / `scheme://host` for a native app. A path, query, fragment,
 * userinfo or whitespace means the value is not an origin, and the approval
 * page never presents it as one.
 */
function isRedirectOrigin(value: string): boolean {
  const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(value)?.[0];
  if (scheme === undefined) return false;
  if (value === scheme) return true;
  if (/[\s@]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!url.hostname) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== '' && url.pathname !== '/') return false;
  return value.replace(/\/$/u, '') === redirectOriginFor(url).replace(/\/$/u, '');
}

/** The origin shape the approval page shows for a parsed redirect URL. */
function redirectOriginFor(url: URL): string {
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  return `${url.protocol}//${url.host}`;
}

/** The `requesting_client` member of `POST /api/device-auth/codes`. */
export const requestingClientSchema = z.object({
  client_id: displayField,
  client_name: displayField,
  redirect_origin: displayField.refine(
    isRedirectOrigin,
    'must be an absolute origin with no path, query, or fragment'
  ),
});

export type RequestingClientPayload = z.infer<typeof requestingClientSchema>;

/** The stored shape back to the wire shape the approval page and the worker read. */
export function toRequestingClient(payload: RequestingClientPayload): RequestingClient {
  return {
    clientId: payload.client_id,
    clientName: payload.client_name,
    redirectOrigin: payload.redirect_origin,
  };
}

/**
 * The requesting client of a stored row, or null when the row carries none
 * (a caller that names no client, and every row written before this flow).
 */
export function requestingClientOfRow(row: {
  requesting_client_id: string | null;
  requesting_client_name: string | null;
  requesting_redirect_origin: string | null;
}): RequestingClient | null {
  const { requesting_client_id, requesting_client_name, requesting_redirect_origin } = row;
  if (
    requesting_client_id === null ||
    requesting_client_name === null ||
    requesting_redirect_origin === null
  ) {
    return null;
  }
  return {
    clientId: requesting_client_id,
    clientName: requesting_client_name,
    redirectOrigin: requesting_redirect_origin,
  };
}
