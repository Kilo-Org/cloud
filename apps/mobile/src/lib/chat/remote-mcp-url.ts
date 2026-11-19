export type RemoteMcpUrlProblem = 'invalidUrl' | 'credentials' | 'fragment' | 'insecureEndpoint';

/**
 * The copy key each URL refusal is said with. The form already refuses every
 * URL it cannot normalize with `fieldUrlInvalid`, so the toast says the same
 * thing the form said, and no other key exists for these.
 */
export const REMOTE_MCP_URL_ERROR_KEYS = {
  invalidUrl: 'modelChat.mcp.fieldUrlInvalid',
  credentials: 'modelChat.mcp.fieldUrlInvalid',
  fragment: 'modelChat.mcp.fieldUrlInvalid',
  insecureEndpoint: 'modelChat.mcp.fieldUrlInvalid',
} as const satisfies Record<RemoteMcpUrlProblem, string>;

export class RemoteMcpUrlError extends Error {
  readonly problem: RemoteMcpUrlProblem;

  constructor(problem: RemoteMcpUrlProblem) {
    super(problem);
    this.problem = problem;
  }
}

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
 * Throws a `RemoteMcpUrlError` for anything the policy refuses, so the caller
 * has one failure to show. Its message is the problem tag, never user-visible
 * prose; the words live in the catalog behind `REMOTE_MCP_URL_ERROR_KEYS`.
 */
export function normalizeRemoteMcpUrl(raw: string): string {
  const trimmed = raw.trim();
  const url = parseUrl(trimmed);

  if (url === undefined) {
    throw new RemoteMcpUrlError('invalidUrl');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new RemoteMcpUrlError('credentials');
  }

  if (trimmed.includes('#')) {
    throw new RemoteMcpUrlError('fragment');
  }

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  ) {
    throw new RemoteMcpUrlError('insecureEndpoint');
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
