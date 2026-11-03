import { logger } from '../logger.js';

type ScmClient = 'github-cli' | 'gitlab-cli' | 'git-lfs' | 'git' | 'other';
type ScmMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OPTIONS' | 'other';
type ScmTarget = 'github-api' | 'github-git' | 'gitlab' | 'bitbucket' | 'other';
type DiagnosticLevel = 'debug' | 'info' | 'warn';

export function logDiagnostic(
  level: DiagnosticLevel,
  fields: Record<string, string | number | boolean | null | undefined>,
  message: string
): void {
  try {
    const scopedLogger = logger.withFields(fields);
    scopedLogger[level](message);
  } catch {
    // Diagnostics must never change outbound request behavior.
  }
}

function classifyScmClient(userAgent: string | null): ScmClient {
  const normalized = userAgent?.toLowerCase() ?? '';
  if (normalized.includes('github cli') || normalized.startsWith('gh/')) return 'github-cli';
  if (normalized.includes('glab')) return 'gitlab-cli';
  if (normalized.includes('git-lfs')) return 'git-lfs';
  if (normalized.includes('git/')) return 'git';
  return 'other';
}

function classifyScmMethod(method: string): ScmMethod {
  const normalized = method.toUpperCase();
  if (
    normalized === 'GET' ||
    normalized === 'HEAD' ||
    normalized === 'POST' ||
    normalized === 'PATCH' ||
    normalized === 'PUT' ||
    normalized === 'DELETE' ||
    normalized === 'OPTIONS'
  ) {
    return normalized;
  }
  return 'other';
}

export function classifyScmTarget(url: URL): ScmTarget {
  if (url.hostname === 'api.github.com') return 'github-api';
  if (url.hostname === 'github.com') return 'github-git';
  if (url.hostname === 'gitlab.com') return 'gitlab';
  if (url.hostname === 'bitbucket.org') return 'bitbucket';
  return 'other';
}

export function classifyScmRoute(url: URL, target: ScmTarget): string {
  if (target === 'github-api') {
    if (url.pathname === '/graphql') return 'graphql';
    if (url.pathname === '/user') return 'user';
    if (url.pathname.startsWith('/repos/')) return 'repository-api';
    return 'github-api-other';
  }
  if (target === 'github-git') {
    if (url.pathname.includes('/info/lfs/')) return 'git-lfs';
    if (url.pathname.endsWith('/info/refs')) return 'git-info-refs';
    if (url.pathname.endsWith('/git-upload-pack')) return 'git-upload-pack';
    if (url.pathname.endsWith('/git-receive-pack')) return 'git-receive-pack';
    return 'github-git-other';
  }
  if (target === 'gitlab') return 'gitlab';
  if (target === 'bitbucket') return 'bitbucket';
  return 'other';
}

export function getSafeRequestLogFields(request: Request) {
  const url = new URL(request.url);
  const target = classifyScmTarget(url);
  return {
    client: classifyScmClient(request.headers.get('User-Agent')),
    method: classifyScmMethod(request.method),
    target,
    route: classifyScmRoute(url, target),
  };
}

export function getCapabilityVersion(capability: string): string {
  const separator = capability.indexOf('.');
  return separator === -1 ? 'unknown' : capability.slice(0, separator);
}

export function classifyDiagnosticError(error: unknown): 'error' | 'unknown' {
  return error instanceof Error ? 'error' : 'unknown';
}
