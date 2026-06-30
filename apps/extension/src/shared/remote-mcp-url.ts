const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export const normalizeRemoteMcpUrl = (value: string): string => {
  const trimmed = value.trim();
  const url = parseUrl(trimmed);

  if (url === undefined) {
    throw new Error('Remote MCP URL must be a valid URL.');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('Remote MCP URL must not include credentials.');
  }

  if (url.hash.length > 0) {
    throw new Error('Remote MCP URL must not include a fragment.');
  }

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  ) {
    throw new Error('Remote MCP URL must use HTTPS unless it points to localhost.');
  }

  url.pathname = url.pathname.replaceAll(/\/+$/g, '') || '/';
  return url.toString();
};
