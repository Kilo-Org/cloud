const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Normalizes a remote MCP server URL, mirroring the extension's rules.
 *
 * A remote server is reached with the user's credential, so the URL is held to
 * the same policy everywhere: HTTPS unless it points at localhost, no embedded
 * credentials, and no fragment. A trailing slash on the path is dropped so two
 * spellings of one endpoint are one server; a query string is preserved.
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

  const queryIndex = trimmed.indexOf('?');
  const endpoint = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : trimmed.slice(queryIndex);
  const normalizedEndpoint = url.pathname === '/' ? endpoint : endpoint.replaceAll(/\/+$/g, '');

  return `${normalizedEndpoint}${query}`;
}
