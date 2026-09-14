// One URL resolver for every route into a review: a pasted link, a shared
// link, a session badge or a recents entry all parse through here, so the
// three providers' URL shapes are decided in exactly one place.
//
// The result is the s1 `ProviderPrRef` identity: platform, the provider's own
// repository path, and the number. A GitLab ref carries the pasted URL's
// origin as `instanceHint` — identity/recents only; the server re-derives the
// authoritative instance (s2), so a mismatched host yields the clear
// not-authorized state, never a redirect.
//
// `parseGitHubPrUrl` (`@/lib/github-pr-url`) stays for compat and owns the
// GitHub arm; this resolver delegates to it rather than re-spelling the
// pattern.

import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import { parseGitHubPrUrl } from '@/lib/github-pr-url';

const MERGE_REQUESTS_SEGMENT = 'merge_requests';
const PULL_REQUESTS_SEGMENT = 'pull-requests';
const BITBUCKET_HOST = 'bitbucket.org';
/** Hosts that can never be a GitLab instance, so a GitHub URL never leaks into the GitLab arm. */
const NON_GITLAB_HOSTS = new Set(['github.com', 'www.github.com']);

/** A path segment GitLab accepts in a project path: the server's own shape. */
const GITLAB_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** A Bitbucket workspace/repository slug: the server's own shape. */
const BITBUCKET_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

type SplitUrl = {
  /** Lowercased scheme, e.g. `https`. */
  scheme: string;
  /** Lowercased authority (host, plus port when non-default). */
  host: string;
  /** Path segments, query and fragment dropped; empty segments preserved. */
  segments: string[];
};

/**
 * Split `http(s)://host[:port]/a/b` into its parts without `URL` — Hermes
 * does not guarantee full WHATWG parsing. Returns `null` for any other
 * scheme, a missing host, or credentials in the authority.
 */
function splitHttpUrl(href: string): SplitUrl | null {
  const match = /^(https?):\/\/([^/?#@]+)([^?#]*)/i.exec(href);
  if (!match) {
    return null;
  }
  const scheme = (match[1] ?? '').toLowerCase();
  const host = (match[2] ?? '').toLowerCase();
  const path = match[3] ?? '';
  if (host.length === 0) {
    return null;
  }
  if (path.length === 0 || path === '/') {
    return { scheme, host, segments: [] };
  }
  if (!path.startsWith('/')) {
    return null;
  }
  return { scheme, host, segments: path.slice(1).split('/') };
}

/** Positive integer from a path segment, or null. No trailing junk. */
function parseNumberSegment(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d+$/.test(segment)) {
    return null;
  }
  const number = Number.parseInt(segment, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * `https://<host>/<group>.../<repo>/-/merge_requests/<n>` and the legacy
 * `https://<host>/<project>/merge_requests/<n>`, on ANY host — gitlab.com
 * and self-managed instances alike. The project path is the FULL nested
 * path; trailing subpaths (`/diffs`, `/review-notes`) are tolerated.
 */
function parseGitLabMrUrl(url: SplitUrl): ProviderPrRef | null {
  if (NON_GITLAB_HOSTS.has(url.host)) {
    return null;
  }
  const { segments } = url;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] === MERGE_REQUESTS_SEGMENT) {
      const ref = gitLabRefAtMarker(url, segments, i);
      if (ref) {
        return ref;
      }
    }
  }
  return null;
}

/** The ref named by `merge_requests/<n>` at `segments[markerAt]`, or null. */
function gitLabRefAtMarker(
  url: SplitUrl,
  segments: string[],
  markerAt: number
): ProviderPrRef | null {
  const modern = segments[markerAt - 1] === '-';
  const pathEnd = modern ? markerAt - 1 : markerAt;
  const mrIid = parseNumberSegment(segments[markerAt + 1]);
  if (mrIid === null || pathEnd < 2) {
    return null;
  }
  const projectPath = segments.slice(0, pathEnd);
  if (!projectPath.every(segment => isGitLabPathSegment(segment))) {
    return null;
  }
  return {
    platform: 'gitlab',
    projectPath: projectPath.join('/'),
    mrIid,
    instanceHint: `${url.scheme}://${url.host}`,
  };
}

function isGitLabPathSegment(segment: string): boolean {
  // '.', '..' and the bare '-' separator are shapes the server never names a
  // project with; accepting them would let `/repo/-/merge_requests/1` read as
  // the project `repo/-`.
  return (
    segment !== '.' && segment !== '..' && segment !== '-' && GITLAB_SEGMENT_PATTERN.test(segment)
  );
}

/**
 * `https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>`, including the
 * `/overview` and other trailing-subpath variants. Bitbucket Cloud only —
 * its host is fixed.
 */
function parseBitbucketPrUrl(url: SplitUrl): ProviderPrRef | null {
  if (url.host !== BITBUCKET_HOST) {
    return null;
  }
  const [workspace, repoSlug, marker, idSegment] = url.segments;
  if (marker !== PULL_REQUESTS_SEGMENT || workspace === undefined || repoSlug === undefined) {
    return null;
  }
  const prId = parseNumberSegment(idSegment);
  if (
    prId === null ||
    !BITBUCKET_SLUG_PATTERN.test(workspace) ||
    !BITBUCKET_SLUG_PATTERN.test(repoSlug)
  ) {
    return null;
  }
  return { platform: 'bitbucket', workspace, repoSlug, prId };
}

/**
 * Parse a pasted/shared PR/MR URL into the provider identity it names.
 *
 * GitHub (`github.com` only — the GitHub App serves no Enterprise host),
 * GitLab merge requests on ANY host including self-managed instances, and
 * Bitbucket Cloud pull requests. Returns `null` for anything else, so the
 * caller can show its invalid-link state.
 */
export function parseProviderPrUrl(href: string): ProviderPrRef | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const github = parseGitHubPrUrl(trimmed);
  if (github) {
    return { platform: 'github', ...github };
  }
  const url = splitHttpUrl(trimmed);
  if (!url) {
    return null;
  }
  return parseGitLabMrUrl(url) ?? parseBitbucketPrUrl(url);
}
