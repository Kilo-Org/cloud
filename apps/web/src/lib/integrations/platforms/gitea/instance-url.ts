import { lookup } from 'dns/promises';
import { isIP } from 'net';

export const DEFAULT_GITEA_INSTANCE_URL = 'https://gitea.com';

export class GiteaInstanceUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiteaInstanceUrlError';
  }
}

export function normalizeGiteaInstanceUrl(instanceUrl?: string): string {
  const rawUrl = (instanceUrl || DEFAULT_GITEA_INSTANCE_URL).trim();
  if (!rawUrl) {
    return DEFAULT_GITEA_INSTANCE_URL;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GiteaInstanceUrlError('Invalid URL format.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GiteaInstanceUrlError('Invalid URL protocol. Must be http or https.');
  }

  if (url.username || url.password) {
    throw new GiteaInstanceUrlError('Gitea instance URL must not include credentials.');
  }

  if (url.search || url.hash) {
    throw new GiteaInstanceUrlError(
      'Gitea instance URL must not include query strings or fragments.'
    );
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (isUnsafeHostname(hostname)) {
    throw new GiteaInstanceUrlError('Gitea instance URL host is not allowed.');
  }

  if (url.protocol !== 'https:') {
    throw new GiteaInstanceUrlError('Invalid URL protocol. Gitea instance URLs must use https.');
  }

  const path = normalizeBasePath(url.pathname);
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

export function isDefaultGiteaInstanceUrl(instanceUrl?: string): boolean {
  return normalizeGiteaInstanceUrl(instanceUrl) === DEFAULT_GITEA_INSTANCE_URL;
}

export function buildGiteaPlatformRepositoryId(input: {
  instanceUrl?: string;
  repoPath: string;
}): string {
  return `${normalizeGiteaInstanceUrl(input.instanceUrl)}/repos/${input.repoPath}`;
}

export function buildGiteaUrl(
  instanceUrl: string | undefined,
  path: string,
  query?: Record<string, string | number | boolean>
): string {
  if (!path.startsWith('/')) {
    throw new Error('Gitea API path must start with a slash');
  }

  const safeBase = new URL(normalizeGiteaInstanceUrl(instanceUrl));
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

export async function assertGiteaUrlResolvesSafely(urlString: string): Promise<void> {
  await resolveGiteaUrlSafely(urlString);
}

export type GiteaResolvedUrl = {
  url: URL;
  address?: string;
  family?: number;
};

export async function resolveGiteaUrlSafely(urlString: string): Promise<GiteaResolvedUrl> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new GiteaInstanceUrlError('Invalid URL format.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GiteaInstanceUrlError('Invalid URL protocol. Must be http or https.');
  }

  if (url.username || url.password) {
    throw new GiteaInstanceUrlError('Gitea URL must not include credentials.');
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
      throw new GiteaInstanceUrlError('Gitea instance URL path is invalid.');
    }

    if (decodedSegment === '.' || decodedSegment === '..') {
      throw new GiteaInstanceUrlError('Gitea instance URL path must not contain traversal.');
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
      throw new GiteaInstanceUrlError('Gitea instance URL host is not allowed.');
    }
    return {};
  }

  if (isDefaultGiteaInstanceUrl(origin)) {
    return {};
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new GiteaInstanceUrlError('Gitea instance URL host could not be resolved.');
  }

  if (addresses.length === 0) {
    throw new GiteaInstanceUrlError('Gitea instance URL host could not be resolved.');
  }

  for (const { address } of addresses) {
    if (isUnsafeHostname(stripIpv6Brackets(address.toLowerCase()))) {
      throw new GiteaInstanceUrlError(
        'Gitea instance URL host resolves to an address that is not allowed.'
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
  const normalized = hostname.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('fec') ||
    normalized.startsWith('fed') ||
    normalized.startsWith('fee') ||
    normalized.startsWith('fef') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8')
  );
}
