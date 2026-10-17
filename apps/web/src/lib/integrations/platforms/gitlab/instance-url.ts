import { lookup } from 'dns/promises';
import { isIP } from 'net';

export const DEFAULT_GITLAB_INSTANCE_URL = 'https://gitlab.com';

export class GitLabInstanceUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabInstanceUrlError';
  }
}

export function normalizeGitLabInstanceUrl(instanceUrl?: string): string {
  const rawUrl = (instanceUrl || DEFAULT_GITLAB_INSTANCE_URL).trim();
  if (!rawUrl) {
    return DEFAULT_GITLAB_INSTANCE_URL;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GitLabInstanceUrlError('Invalid URL format.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GitLabInstanceUrlError('Invalid URL protocol. Must be http or https.');
  }

  if (url.username || url.password) {
    throw new GitLabInstanceUrlError('GitLab instance URL must not include credentials.');
  }

  if (url.search || url.hash) {
    throw new GitLabInstanceUrlError(
      'GitLab instance URL must not include query strings or fragments.'
    );
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (isUnsafeHostname(hostname)) {
    throw new GitLabInstanceUrlError('GitLab instance URL host is not allowed.');
  }

  if (url.protocol !== 'https:') {
    throw new GitLabInstanceUrlError('Invalid URL protocol. GitLab instance URLs must use https.');
  }

  const path = normalizeBasePath(url.pathname);
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

export function isDefaultGitLabInstanceUrl(instanceUrl?: string): boolean {
  return normalizeGitLabInstanceUrl(instanceUrl) === DEFAULT_GITLAB_INSTANCE_URL;
}

export function buildGitLabPlatformRepositoryId(input: {
  instanceUrl?: string;
  projectId: number;
}): string {
  return `${normalizeGitLabInstanceUrl(input.instanceUrl)}/-/projects/${input.projectId}`;
}

export function buildGitLabUrl(
  instanceUrl: string | undefined,
  path: string,
  query?: Record<string, string | number | boolean>
): string {
  if (!path.startsWith('/')) {
    throw new Error('GitLab API path must start with a slash');
  }

  const safeBase = new URL(normalizeGitLabInstanceUrl(instanceUrl));
  const basePath = safeBase.pathname.replace(/\/+$/, '');
  safeBase.pathname = `${basePath}${path}`;
  safeBase.search = '';
  safeBase.hash = '';

  const queryParams = query
    ? Object.entries(query).map(
        ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      )
    : [];

  if (queryParams.length > 0) {
    safeBase.search = queryParams.join('&');
  }

  return safeBase.toString();
}

export async function assertGitLabUrlResolvesSafely(urlString: string): Promise<void> {
  await resolveGitLabUrlSafely(urlString);
}

export type GitLabResolvedUrl = {
  url: URL;
  address?: string;
  family?: number;
};

export async function resolveGitLabUrlSafely(urlString: string): Promise<GitLabResolvedUrl> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new GitLabInstanceUrlError('Invalid URL format.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GitLabInstanceUrlError('Invalid URL protocol. Must be http or https.');
  }

  if (url.username || url.password) {
    throw new GitLabInstanceUrlError('GitLab URL must not include credentials.');
  }

  const address = await resolveHostnameSafely(
    stripIpv6Brackets(url.hostname.toLowerCase()),
    url.origin
  );
  return { url, ...address };
}

function normalizeBasePath(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return '';
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '';
  }

  for (const segment of segments) {
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new GitLabInstanceUrlError('GitLab instance URL path is invalid.');
    }

    if (decodedSegment === '.' || decodedSegment === '..') {
      throw new GitLabInstanceUrlError('GitLab instance URL path must not contain traversal.');
    }
  }

  return `/${segments.join('/')}`;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

function isUnsafeHostname(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.includes('%')
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return isUnsafeIpv4(hostname);
  }

  if (ipVersion === 6) {
    return isUnsafeIpv6(hostname);
  }

  return false;
}

async function resolveHostnameSafely(
  hostname: string,
  origin: string
): Promise<{ address?: string; family?: number }> {
  if (isIP(hostname)) {
    if (isUnsafeHostname(hostname)) {
      throw new GitLabInstanceUrlError('GitLab instance URL host is not allowed.');
    }
    return {};
  }

  if (isDefaultGitLabInstanceUrl(origin)) {
    return {};
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new GitLabInstanceUrlError('GitLab instance URL host could not be resolved.');
  }

  if (addresses.length === 0) {
    throw new GitLabInstanceUrlError('GitLab instance URL host could not be resolved.');
  }

  for (const { address } of addresses) {
    if (isUnsafeHostname(stripIpv6Brackets(address.toLowerCase()))) {
      throw new GitLabInstanceUrlError(
        'GitLab instance URL host resolves to an address that is not allowed.'
      );
    }
  }

  return addresses[0];
}

function isUnsafeIpv4(hostname: string): boolean {
  const [first, second, third, fourth] = hostname.split('.').map(Number);
  if ([first, second, third, fourth].some(octet => !Number.isInteger(octet))) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    (first === 255 && second === 255 && third === 255 && fourth === 255)
  );
}

function isUnsafeIpv6(hostname: string): boolean {
  const bytes = parseIpv6ToBytes(hostname);
  if (!bytes) {
    return true;
  }

  const hex = (offset: number) => (bytes[offset] << 8) | bytes[offset + 1];

  if (hex(0) === 0x64 && hex(2) === 0xff9b && hex(4) === 0 && hex(6) === 0 && hex(8) === 0) {
    // NAT64 well-known prefix (64:ff9b::/96)
    return true;
  }
  if (hex(0) === 0x64 && hex(2) === 0xff9b && bytes[4] === 0 && bytes[5] === 1) {
    // Local-use NAT64 (64:ff9b:1::/48)
    return true;
  }
  if (hex(0) === 0x0100 && hex(2) === 0 && hex(4) === 0 && hex(6) === 0) {
    // Discard-only (100::/64)
    return true;
  }
  if (hex(0) === 0x3fff && (bytes[1] & 0xf0) === 0xf0) {
    // Documentation (3fff::/20)
    return true;
  }
  if (hex(0) === 0x2001 && hex(2) === 0x0db8) {
    // Documentation (2001:db8::/32)
    return true;
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    // Unique local (fc00::/7)
    return true;
  }
  if ((bytes[0] & 0xff) === 0xff) {
    // Multicast (ff00::/8)
    return true;
  }
  if (hex(0) === 0xfec0 && (bytes[2] & 0xf0) === 0x00 && hex(4) === 0 && hex(6) === 0) {
    // Deprecated site-local (fec0::/10)
    return true;
  }
  if ((bytes[0] & 0xff) === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    // Link-local (fe80::/10)
    return true;
  }

  const embedded = embeddedIpv4Bytes(bytes);
  if (embedded) {
    const ipv4 = embedded.join('.');
    if (isUnsafeIpv4(ipv4)) {
      return true;
    }
  }

  return false;
}

function embeddedIpv4Bytes(bytes: Uint8Array): Uint8Array | null {
  const firstTenZero = bytes.slice(0, 10).every(byte => byte === 0);
  if (firstTenZero && bytes[10] === 0 && bytes[11] === 0) {
    // IPv4-compatible (::/96)
    return bytes.slice(12, 16);
  }
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    // IPv4-mapped (::ffff:0:0/96)
    return bytes.slice(12, 16);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    // 6to4 (2002::/16) embeds the IPv4 in bytes 2-5
    return bytes.slice(2, 6);
  }
  return null;
}

function parseIpv6ToBytes(hostname: string): Uint8Array | null {
  const input = hostname.toLowerCase();
  if (isIP(input) !== 6) {
    return null;
  }

  const bytes = new Uint8Array(16);

  let head = input;
  let tail = '';
  const doubleColon = input.indexOf('::');
  if (doubleColon !== -1) {
    if (input.indexOf('::', doubleColon + 1) !== -1) {
      return null;
    }
    head = input.slice(0, doubleColon);
    tail = input.slice(doubleColon + 2);
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }
    const groups = part.split(':');
    const values: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      let group = groups[i];
      const last = i === groups.length - 1;
      if (group.includes('.')) {
        if (!last) {
          return null;
        }
        const ipv4 = group.split('.').map(Number);
        if (ipv4.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
          return null;
        }
        values.push((ipv4[0] << 8) | ipv4[1]);
        values.push((ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }
      values.push(parseInt(group, 16));
    }
    return values;
  };

  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (!headGroups || !tailGroups) {
    return null;
  }

  const total = headGroups.length + tailGroups.length;
  if (doubleColon !== -1) {
    if (total > 7) {
      return null;
    }
  } else if (total !== 8) {
    return null;
  }

  for (let i = 0; i < headGroups.length; i++) {
    bytes[i * 2] = headGroups[i] >> 8;
    bytes[i * 2 + 1] = headGroups[i] & 0xff;
  }
  const tailStart = doubleColon !== -1 ? 16 - tailGroups.length * 2 : headGroups.length * 2;
  for (let i = 0; i < tailGroups.length; i++) {
    bytes[tailStart + i * 2] = tailGroups[i] >> 8;
    bytes[tailStart + i * 2 + 1] = tailGroups[i] & 0xff;
  }

  return bytes;
}
