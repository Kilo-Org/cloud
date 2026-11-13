const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Normalizes a remote MCP server URL.
 *
 * A remote server is reached with the user's credential, so the URL is held to
 * the same policy everywhere: HTTPS unless it points at localhost, no embedded
 * credentials, and no fragment. The answer is one canonical spelling of the
 * endpoint — the parser's lowercased scheme and host, no default port, and no
 * trailing slash on the path, root path included — so two spellings of one
 * endpoint are one server. A query string is preserved.
 *
 * Throws an `Error` for anything else, so the caller has one failure to show.
 */
export function normalizeRemoteMcpUrl(raw: string): string {
  const trimmed = raw.trim();
  const url = parseUrl(trimmed);

  if (url === undefined) {
    throw new Error('Remote MCP URL must be a valid URL.');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Remote MCP URL must not include credentials.');
  }

  if (trimmed.includes('#')) {
    throw new Error('Remote MCP URL must not include a fragment.');
  }

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  ) {
    throw new Error('Remote MCP URL must use HTTPS unless it points to localhost.');
  }

  return `${url.protocol}//${url.host}${url.pathname.replaceAll(/\/+$/g, '')}${url.search}`;
}

/**
 * Whether two spellings name one remote MCP endpoint.
 *
 * A credential belongs to an endpoint, so every place that decides "the same
 * server" — an edit, the OAuth state, the saved bearer value, the edit form —
 * compares the normalized form. A value that cannot be normalized is compared
 * as written, so it matches only itself.
 */
export function sameRemoteMcpEndpoint(saved: string, url: string): boolean {
  try {
    return normalizeRemoteMcpUrl(saved) === normalizeRemoteMcpUrl(url);
  } catch {
    return saved === url;
  }
}
