import type { RedeemGitHubSessionCapabilityFailureReason } from './index.js';

// Frozen request policy for existing container-bound kgh2 workspaces.
const GITHUB_USER_ATTACHMENT_PATH = '/user-attachments/assets';

type GitHubCapabilityCredential = 'pinned' | 'user' | 'none';

type GitHubCapabilityUpstream =
  | {
      failure: RedeemGitHubSessionCapabilityFailureReason;
      credential?: never;
      repositoryId?: never;
    }
  | { failure: null; credential: GitHubCapabilityCredential; repositoryId?: number };

// Methods that may reach the recorded repository's REST surface. Everything here is
// repository-confined before the credential is minted, so the list covers the write
// operations agent sessions perform (pull requests, reviews, comments, releases).
const GITHUB_REPOSITORY_API_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'];
const GITHUB_UPLOAD_METHODS = ['GET', 'HEAD', 'POST', 'DELETE'];
const GITHUB_IDENTITY_METHODS = ['GET', 'HEAD'];
const GITHUB_REGISTRY_METHODS = ['GET', 'HEAD'];

function repositoryApiPath(repository: { owner: string; repo: string }): string {
  return `/repos/${repository.owner}/${repository.repo}`;
}

function parseGitHubRepositoryId(url: URL): number | null {
  if (url.search.includes(';')) return null;
  const values = url.searchParams.getAll('repository_id');
  if (values.length !== 1) return null;
  const value = values[0];
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const repositoryId = Number(value);
  return Number.isSafeInteger(repositoryId) ? repositoryId : null;
}

function isRepositoryApiPath(path: string, repository: { owner: string; repo: string }): boolean {
  const prefix = repositoryApiPath(repository);
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isRepositoryRootPath(path: string, repository: { owner: string; repo: string }): boolean {
  const root = `/${repository.owner}/${repository.repo}`;
  return (
    path === root ||
    path.startsWith(`${root}/`) ||
    path === `${root}.git` ||
    path.startsWith(`${root}.git/`)
  );
}

/**
 * Matches a Git smart-HTTP or LFS endpoint by the path after the repository
 * root, for example `/info/refs` or `/git-receive-pack`.
 */
function matchesGitRequestSuffix(method: string, url: URL, suffix: string): boolean {
  if (method === 'GET' && suffix === '/info/refs') {
    const entries = [...url.searchParams.entries()];
    const service = url.searchParams.get('service');
    return (
      entries.length === 1 && (service === 'git-upload-pack' || service === 'git-receive-pack')
    );
  }
  if (method === 'GET' && suffix === '/info/lfs/locks') return true;
  if (method !== 'POST' || url.search !== '') return false;
  return (
    suffix === '/git-upload-pack' ||
    suffix === '/git-receive-pack' ||
    suffix === '/info/lfs/objects/batch' ||
    suffix === '/info/lfs/locks' ||
    suffix === '/info/lfs/locks/verify' ||
    /^\/info\/lfs\/locks\/[^/]+\/unlock$/.test(suffix)
  );
}

function matchesGitHubGitRequest(
  method: string,
  url: URL,
  path: string,
  repositoryPath: string
): boolean {
  if (!path.startsWith(repositoryPath)) return false;
  return matchesGitRequestSuffix(method, url, path.slice(repositoryPath.length));
}

/**
 * A clone URL may omit the `.git` suffix, and GitHub answers it with a redirect to
 * the suffixed form, so both spellings belong to the same repository.
 */
function matchesRepositoryGitRequest(
  method: string,
  url: URL,
  path: string,
  repository: { owner: string; repo: string }
): boolean {
  const root = `/${repository.owner}/${repository.repo}`;
  return (
    matchesGitHubGitRequest(method, url, path, `${root}.git`) ||
    matchesGitHubGitRequest(method, url, path, root)
  );
}

/**
 * Matches the Git endpoints that need no authorization header, such as a public
 * repository's clone and LFS requests.
 */
function matchesAnonymousGitHubGitRequest(method: string, url: URL, path: string): boolean {
  const segments = path.split('/');
  if (segments.length < 3) return false;
  return matchesGitRequestSuffix(method, url, `/${segments.slice(3).join('/')}`);
}

/**
 * GitHub Packages publishes a repository owner's packages under its own scope, so
 * registry reads are confined to `@<owner>` (metadata, tarball, and download paths).
 */
function isOwnerPackageScopePath(path: string, owner: string): boolean {
  const scope = `@${owner}`;
  const segments = path.split('/');
  return (
    (segments[1] === scope && segments.length >= 3) ||
    (segments[1] === 'download' && segments[2] === scope && segments.length >= 4)
  );
}

export function parseGitHubCapabilityRequest(
  requestMethod: string,
  requestUrl: string
):
  | { failure: RedeemGitHubSessionCapabilityFailureReason; request?: never }
  | {
      failure: null;
      request: { url: URL; method: string; path: string };
    } {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { failure: 'invalid_upstream_url' };
  }
  if (url.protocol !== 'https:') return { failure: 'invalid_upstream_url' };
  if (url.username || url.password || url.hash) return { failure: 'invalid_upstream_url' };
  if (url.port !== '') return { failure: 'upstream_host_not_allowed' };
  const path = decodePathnameIteratively(url.pathname);
  if (path === null || path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) {
    return { failure: 'invalid_upstream_url' };
  }
  return {
    failure: null,
    request: { url, method: requestMethod.toUpperCase(), path: path.toLowerCase() },
  };
}

export function validateLegacyGitHubRequest(
  requestMethod: string,
  requestUrl: string,
  repository: { owner: string; repo: string; permissionScope?: 'repository' }
): GitHubCapabilityUpstream {
  const parsed = parseGitHubCapabilityRequest(requestMethod, requestUrl);
  if (parsed.failure) return { failure: parsed.failure };
  const { url, method, path } = parsed.request;

  if (url.hostname === 'api.github.com') {
    if (path === '/user') {
      return GITHUB_IDENTITY_METHODS.includes(method)
        ? { failure: null, credential: 'pinned' }
        : { failure: 'invalid_upstream_request' };
    }
    if (path === '/graphql') {
      // Intentionally preserve the selected user's credential: webhook approvals must
      // run as that user, not the installation bot. GraphQL has no repository URL scope,
      // so user-source requests retain the user's GitHub permissions by design.
      // Repository-only and installation-source capabilities keep their scoped token.
      return method === 'POST'
        ? { failure: null, credential: 'pinned' }
        : { failure: 'invalid_upstream_request' };
    }
    if (!isRepositoryApiPath(path, repository)) return { failure: 'repository_mismatch' };
    return GITHUB_REPOSITORY_API_METHODS.includes(method)
      ? { failure: null, credential: 'pinned' }
      : { failure: 'invalid_upstream_request' };
  }
  if (url.hostname === 'uploads.github.com') {
    if (path === GITHUB_USER_ATTACHMENT_PATH) {
      if (method !== 'POST') return { failure: 'invalid_upstream_request' };
      // Attachments need the user's OAuth token, which repository-only authority never grants.
      if (repository.permissionScope === 'repository') {
        return { failure: 'invalid_upstream_request' };
      }
      const repositoryId = parseGitHubRepositoryId(url);
      return repositoryId === null
        ? { failure: 'invalid_upstream_request' }
        : { failure: null, credential: 'user', repositoryId };
    }
    if (!isRepositoryApiPath(path, repository)) return { failure: 'repository_mismatch' };
    return GITHUB_UPLOAD_METHODS.includes(method)
      ? { failure: null, credential: 'pinned' }
      : { failure: 'invalid_upstream_request' };
  }
  if (url.hostname === 'npm.pkg.github.com') {
    if (!GITHUB_REGISTRY_METHODS.includes(method)) return { failure: 'invalid_upstream_request' };
    return isOwnerPackageScopePath(path, repository.owner)
      ? { failure: null, credential: 'pinned' }
      : { failure: 'repository_mismatch' };
  }
  if (url.hostname === 'github.com') {
    if (matchesRepositoryGitRequest(method, url, path, repository)) {
      return { failure: null, credential: 'pinned' };
    }
    if (matchesAnonymousGitHubGitRequest(method, url, path)) {
      return { failure: null, credential: 'none' };
    }
    return isRepositoryRootPath(path, repository)
      ? { failure: 'invalid_upstream_request' }
      : { failure: 'repository_mismatch' };
  }
  return { failure: 'upstream_host_not_allowed' };
}

export function decodePathnameIteratively(pathname: string): string | null {
  let decoded = pathname;
  for (let depth = 0; depth < 4; depth++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}
