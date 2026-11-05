/**
 * The parts of an `http(s)` URL's authority, split the way the native client
 * reads them. One parser serves every destination check.
 */
export type HttpUrlAuthority = {
  /** Lowercased scheme. */
  protocol: 'http' | 'https';
  /** Lowercased hostname; a bracketed IPv6 literal keeps its brackets. */
  hostname: string;
  /** WHATWG-canonical numeric port, or `''` when the URL carries none. */
  port: string;
  /** True when the authority carries userinfo before the host. */
  hasUserInfo: boolean;
};

const IPV6_HOSTNAME_PATTERN = /^\[[0-9a-f:.]+\]$/;
const REGISTERED_HOSTNAME_PATTERN = /^[a-z0-9\u00A1-\uFFFF._-]+$/;
const PORT_PATTERN = /^\d+$/;

/**
 * Splits an authority's host and port, or reports null for a shape that does not
 * name a resolvable endpoint. An IPv6 host keeps its brackets; every other host
 * is lowercased and restricted to registered-name characters.
 */
function parseAuthorityHost(hostPort: string): { hostname: string; port: string } | null {
  let hostname = '';
  let port = '';
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) {
      return null;
    }
    hostname = hostPort.slice(0, close + 1).toLowerCase();
    const afterBracket = hostPort.slice(close + 1);
    if (afterBracket === '') {
      port = '';
    } else if (afterBracket.startsWith(':')) {
      port = afterBracket.slice(1);
    } else {
      return null;
    }
    if (!IPV6_HOSTNAME_PATTERN.test(hostname)) {
      return null;
    }
  } else {
    const colon = hostPort.indexOf(':');
    hostname = (colon === -1 ? hostPort : hostPort.slice(0, colon)).toLowerCase();
    port = colon === -1 ? '' : hostPort.slice(colon + 1);
    if (port.includes(':') || !REGISTERED_HOSTNAME_PATTERN.test(hostname)) {
      return null;
    }
  }
  if (port !== '' && !PORT_PATTERN.test(port)) {
    return null;
  }
  return { hostname, port };
}

/**
 * Parse an `http(s)` URL's authority, or null when the URL is not `http(s)` or
 * its authority is malformed. A port above the 16-bit maximum reports null too,
 * matching WHATWG parsing.
 */
export function parseHttpUrlAuthority(uri: string): HttpUrlAuthority | null {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) {
    return null;
  }
  const protocol = uri.slice(0, schemeEnd).toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    return null;
  }
  // The authority ends at the first path, query, fragment, or backslash
  // delimiter. A backslash is a path separator for http(s) under WHATWG
  // parsing, so it must end the authority here too.
  const remainder = uri.slice(schemeEnd + 3);
  const authorityEnd = remainder.search(/[/?#\\]/);
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd);
  // Userinfo ends at the last '@' in the authority; a path '@' is already
  // excluded above and can never be promoted to the host.
  const userInfoEnd = authority.lastIndexOf('@');
  const host = parseAuthorityHost(authority.slice(userInfoEnd + 1));
  if (host === null) {
    return null;
  }
  // WHATWG parses the port as a number: leading zeros drop and a port above
  // the 16-bit maximum fails. Canonicalize to that numeric endpoint or fail
  // closed, so `:0443` names the same endpoint as `:443`.
  let port = '';
  if (host.port !== '') {
    const portNumber = Number(host.port);
    if (portNumber > 65_535) {
      return null;
    }
    port = String(portNumber);
  }
  return { protocol, hostname: host.hostname, port, hasUserInfo: userInfoEnd !== -1 };
}
