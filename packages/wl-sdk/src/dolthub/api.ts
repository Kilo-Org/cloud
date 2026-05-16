/**
 * Base HTTP plumbing for the DoltHub REST API.
 *
 * Higher-level modules (`read.ts`, `write.ts`, `branches.ts`, …) compose
 * `doltFetch` to issue typed requests. Auth is explicit per call —
 * callers pass either a `{ token }` or `{ anonymous: true }` value.
 *
 * Token authentication uses DoltHub's own scheme: `authorization: token
 * <token>` (lowercase, scheme `token`, NOT `Bearer`). Anonymous calls
 * omit the header entirely.
 */

export const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';
export const DOLTHUB_WEB_BASE = 'https://www.dolthub.com';

export type DoltHubAuth = { token: string } | { anonymous: true };

/** Hook callbacks. Receivers must NEVER log the auth header. */
export type DoltFetchHooks = {
  onRequest?: (info: { method: string; url: string }) => void;
  onError?: (info: { method: string; url: string; status: number; body: unknown }) => void;
};

export type DoltFetchOptions = {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';
  /** Path beneath `DOLTHUB_API_BASE`, must start with `/`. */
  path: string;
  auth: DoltHubAuth;
  /** Query string params; values are URL-encoded. */
  query?: Record<string, string | undefined>;
  /** JSON body; serialized by this helper. */
  body?: unknown;
  /** Inject a fetch implementation (used by tests). */
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type DoltFetchResult = {
  status: number;
  headers: Headers;
  /** Raw response body text. */
  text: string;
  /** Parsed JSON, or `undefined` if the body wasn't JSON. */
  json: unknown;
};

/**
 * Error thrown by every wl-sdk DoltHub helper on a non-2xx response or
 * a malformed payload. `body` is the parsed response (or raw text on
 * non-JSON bodies). `url` is the full URL we sent (no auth header).
 */
export class WlDoltHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly url: string
  ) {
    super(message);
    this.name = 'WlDoltHubError';
  }
}

/**
 * Build a fully-qualified DoltHub API URL. Path segments are joined as
 * given — the caller is responsible for `encodeURIComponent`ing
 * untrusted parts.
 */
export function buildDoltUrl(path: string, query?: Record<string, string | undefined>): string {
  const base = `${DOLTHUB_API_BASE}${path}`;
  if (!query) return base;
  const params: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}

function buildAuthHeader(auth: DoltHubAuth): Record<string, string> {
  if ('anonymous' in auth) return {};
  return { authorization: `token ${auth.token}` };
}

/**
 * Issue a single DoltHub API request. Returns the parsed body on any
 * status (so callers can branch on `result.status` for soft errors)
 * and throws `WlDoltHubError` only for transport failures. Callers
 * decide whether a non-2xx response is an error.
 */
export async function doltFetch(opts: DoltFetchOptions): Promise<DoltFetchResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = buildDoltUrl(opts.path, opts.query);

  const headers: Record<string, string> = {
    // Bypass Cloudflare's subrequest cache. DoltHub returns stale
    // reads otherwise, which surfaces as ghost branches / merged PRs
    // not appearing immediately. The DOM `cache: 'no-store'` init is
    // rejected by workerd; the cache-control header is what
    // propagates.
    'cache-control': 'no-cache',
    ...buildAuthHeader(opts.auth),
  };

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  opts.hooks?.onRequest?.({ method: opts.method, url });

  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    opts.hooks?.onError?.({ method: opts.method, url, status: res.status, body: json ?? text });
  }

  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Convenience: throw `WlDoltHubError` if the response is non-2xx.
 * Used by helpers that don't need to inspect error envelopes.
 */
export function expectOk(res: DoltFetchResult, url: string, context: string): void {
  if (res.status >= 200 && res.status < 300) return;
  throw new WlDoltHubError(
    `${context} failed (${res.status})`,
    res.status,
    res.json ?? res.text,
    url
  );
}
