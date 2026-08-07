/**
 * Pure total Sentry event and breadcrumb scrubbers.
 *
 * Every function wraps its body so an unexpected payload shape returns the
 * input unchanged rather than throwing. A throwing `beforeSend` or
 * `beforeBreadcrumb` drops the event silently, which would hide crashes.
 */

/** Strip the query string from a URL. Returns empty string if parsing fails. */
function stripQuery(url: unknown): string {
  if (typeof url !== 'string') {
    return '';
  }
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

/** True when the value looks like a secret token. */
function isTokenShape(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.startsWith('Bearer ')) {
    return true;
  }
  // 20+ consecutive base64url characters (A-Z a-z 0-9 - _)
  return /[A-Za-z0-9_-]{20,}/.test(value);
}

/** Redact every token-shaped value in a flat key-value map. */
function redactTokens(
  map: Record<string, unknown> | undefined | null
): Record<string, unknown> | undefined {
  if (map == null) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    result[key] = isTokenShape(value) ? '[redacted]' : value;
  }
  return result;
}

/**
 * Scrub a Sentry event before it is sent.
 *
 * - Strips query strings from request URL and contexts.response URL.
 * - Deletes `user.email`, `user.username`, and `user.ip_address`.
 * - Redacts token-shaped values (20+ base64url chars or `Bearer ` prefix)
 *   in `event.extra` and `event.tags`.
 */
export function scrubEvent(event: unknown): unknown {
  try {
    if (event == null || typeof event !== 'object') {
      return event;
    }

    const e = event as Record<string, unknown>;

    // request.url
    if (e.request != null && typeof e.request === 'object') {
      const req = e.request as Record<string, unknown>;
      if ('url' in req) {
        req.url = stripQuery(req.url);
      }
    }

    // contexts.response (nested under contexts)
    if (e.contexts != null && typeof e.contexts === 'object') {
      const ctx = e.contexts as Record<string, unknown>;
      if (ctx.response != null && typeof ctx.response === 'object') {
        const resp = ctx.response as Record<string, unknown>;
        if ('url' in resp) {
          resp.url = stripQuery(resp.url);
        }
      }
    }

    // user identity
    if (e.user != null && typeof e.user === 'object') {
      const user = e.user as Record<string, unknown>;
      delete user.email;
      delete user.username;
      delete user.ip_address;
    }

    // extras and tags
    if ('extra' in e) {
      e.extra = redactTokens(e.extra as Record<string, unknown> | undefined);
    }
    if ('tags' in e) {
      e.tags = redactTokens(e.tags as Record<string, unknown> | undefined);
    }

    return event;
  } catch {
    return event;
  }
}

/**
 * Scrub a Sentry breadcrumb before it is attached.
 *
 * - Returns `null` for `console` breadcrumbs (they carry prompt/response text).
 * - Strips the query string from `breadcrumb.data.url`.
 * - Leaves navigation and fetch breadcrumbs otherwise intact.
 */
export function scrubBreadcrumb(breadcrumb: unknown): unknown {
  try {
    if (breadcrumb == null || typeof breadcrumb !== 'object') {
      return breadcrumb;
    }

    const b = breadcrumb as Record<string, unknown>;

    if (b.category === 'console') {
      return null;
    }

    if (b.data != null && typeof b.data === 'object') {
      const data = b.data as Record<string, unknown>;
      if ('url' in data) {
        data.url = stripQuery(data.url);
      }
    }

    return breadcrumb;
  } catch {
    return breadcrumb;
  }
}
