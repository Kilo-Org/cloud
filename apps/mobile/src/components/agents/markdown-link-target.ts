type WebLinkTarget = {
  kind: 'web';
  scheme: 'http' | 'https';
  /** Trust key: lowercased hostname plus a non-default port. */
  host: string;
  /** Canonical URL that matches `host`, built from the parsed parts. */
  href: string;
};

type SchemeLinkTarget = {
  kind: 'scheme';
  scheme: string;
  href: string;
};

export type MarkdownLinkTarget = WebLinkTarget | SchemeLinkTarget;

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const LEADING_SLASHES = /^[/\\]+/;
const AUTHORITY_END = /[/\\?#]/;
// Hostnames are matched as written; percent-encoding is outside the accepted
// set.
const HOST_PATTERN = /^[\p{L}\p{N}~!$&'()*+,;=._:-]+$/u;
const IPV6_PATTERN = /^[0-9a-f:.]+$/;
const PORT_PATTERN = /^\d{1,5}$/;
const CONTROL_CHARS = /[\p{Cc}]/u;

function splitAuthority(authority: string): { host: string; port: string } | null {
  // Userinfo ends at the last "@" in the authority, as the URL spec says.
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);

  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    if (close === -1) {
      return null;
    }
    const host = hostAndPort.slice(0, close + 1);
    const afterHost = hostAndPort.slice(close + 1);
    if (afterHost === '') {
      return { host, port: '' };
    }
    return afterHost.startsWith(':') ? { host, port: afterHost.slice(1) } : null;
  }

  const colon = hostAndPort.indexOf(':');
  if (colon === -1) {
    return { host: hostAndPort, port: '' };
  }
  return { host: hostAndPort.slice(0, colon), port: hostAndPort.slice(colon + 1) };
}

function parseWebTarget(remainder: string, scheme: 'http' | 'https'): WebLinkTarget | null {
  const afterSlashes = remainder.replace(LEADING_SLASHES, '');
  const authorityEnd = afterSlashes.search(AUTHORITY_END);
  const authority = authorityEnd === -1 ? afterSlashes : afterSlashes.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : afterSlashes.slice(authorityEnd);

  const parts = splitAuthority(authority);
  if (parts === null) {
    return null;
  }

  const hostname = parts.host.toLowerCase().replace(/\.$/, '');
  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1);
    if (!IPV6_PATTERN.test(inner) || !inner.includes(':')) {
      return null;
    }
  } else if (!HOST_PATTERN.test(hostname)) {
    return null;
  }

  // A port is a number, so the comparison and the opened URL both use its
  // numeric value.
  const port = parts.port === '' ? '' : String(Number(parts.port));
  if (port !== '' && (!PORT_PATTERN.test(port) || Number(port) > 65_535)) {
    return null;
  }
  const isDefaultPort =
    (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const keepPort = port !== '' && !isDefaultPort;

  // The trust key and the opened URL are built from the same parsed parts, so
  // the host the user confirms is always the host the browser receives.
  const authorityOut = `${hostname}${keepPort ? `:${port}` : ''}`;
  let path = '/';
  if (tail.startsWith('?') || tail.startsWith('#')) {
    path = `/${tail}`;
  } else if (tail !== '') {
    // Keep the path exactly as written; only the authority separator is
    // normalized.
    path = tail.startsWith('\\') ? `/${tail.slice(1)}` : tail;
  }

  return {
    kind: 'web',
    scheme,
    host: authorityOut,
    href: `${scheme}://${authorityOut}${path}`,
  };
}

/**
 * Classifies a markdown href before anything opens it. The value is parsed
 * once, here, so the caller decides from the parsed protocol and host instead
 * of the raw string: HTTP(S) in any spelling of the authority (missing or
 * extra slashes, backslashes, mixed case, userinfo, a bare host) resolves to
 * the same web target, and only allowlisted non-web schemes survive.
 *
 * Returns null for values that do not parse or whose scheme is not allowed.
 */
export function parseMarkdownLinkTarget(href: string): MarkdownLinkTarget | null {
  const value = href.trim();
  const match = SCHEME_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const scheme = (match[1] ?? '').toLowerCase();
  const remainder = value.slice(match[0].length);

  if (scheme === 'http' || scheme === 'https') {
    return parseWebTarget(remainder, scheme);
  }
  if (scheme === 'mailto' || scheme === 'tel') {
    const schemeTarget = remainder.trim();
    if (schemeTarget === '' || CONTROL_CHARS.test(schemeTarget)) {
      return null;
    }
    return { kind: 'scheme', scheme, href: `${scheme}:${schemeTarget}` };
  }
  return null;
}
