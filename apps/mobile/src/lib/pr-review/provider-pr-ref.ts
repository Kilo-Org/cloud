// Mobile-side identity helpers for a provider PR/MR ref.
//
// One screen tree renders GitHub pull requests, GitLab merge requests and
// Bitbucket pull requests, so every surface needs the same three answers
// about the thing it is showing: which provider, which repository, which
// number. `ProviderPrRef` (s1, `@kilocode/app-shared/provider-review`) is
// that identity; this module is the route <-> ref translation plus the
// display/keying helpers the presentation needs.
//
// Route shape: `/(app)/pr-review/[platform]/[...identity]`, where the LAST
// identity segment is the number (MR iid / PR id) and everything before it
// is the project path — a GitLab full nested path (`group/sub/repo`) or a
// Bitbucket `workspace/repo`. GitHub keeps its original three-segment
// `[owner]/[repo]/[number]` route; `providerPrRoutePath` sends a GitHub ref
// back there so that surface is untouched.

import {
  type GitHubPrRef,
  PROVIDER_REVIEW_CAPABILITIES,
  type ProviderPrPlatform,
  type ProviderPrRef,
  providerPrRefKey,
  providerPrTerm,
  type ProviderReviewCapabilities,
} from '@kilocode/app-shared/provider-review';
import { type Href } from 'expo-router';
import { createContext, createElement, type ReactNode, useContext, useMemo } from 'react';

import { parseParam, parsePositiveIntParam } from '@/lib/route-params';

export { providerPrRefKey, type GitHubPrRef, type ProviderPrPlatform, type ProviderPrRef };

const PROVIDER_PR_PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;

/** Narrows an already-parsed route segment onto the platform vocabulary. */
export function isProviderPrPlatform(value: string | null): value is ProviderPrPlatform {
  return value !== null && (PROVIDER_PR_PLATFORMS as readonly string[]).includes(value);
}

/** The GitHub arm of the ref, from the triple the existing route already parses. */
export function githubPrRef(owner: string, repo: string, number: number): GitHubPrRef {
  return { platform: 'github', owner, repo, number };
}

/**
 * The i18n key holding the provider's own term for a PR/MR. Copy never
 * spells "pull request" for GitLab: `providerPrTerm` decides the noun and
 * this maps it onto the catalog block s5 added (`prReview.terms`).
 */
export function providerPrTermKey(
  platform: ProviderPrPlatform
): 'prReview.terms.mergeRequest' | 'prReview.terms.pullRequest' {
  return providerPrTerm(platform) === 'merge request'
    ? 'prReview.terms.mergeRequest'
    : 'prReview.terms.pullRequest';
}

/** The number a provider gives this change: a PR number, an MR iid, a PR id. */
export function providerPrNumber(ref: ProviderPrRef): number {
  if (ref.platform === 'github') {
    return ref.number;
  }
  return ref.platform === 'gitlab' ? ref.mrIid : ref.prId;
}

/**
 * The repository path as the provider writes it: `owner/repo` on GitHub and
 * Bitbucket, the FULL nested path on GitLab (never just the last segment).
 */
export function providerPrRepoPath(ref: ProviderPrRef): string {
  if (ref.platform === 'github') {
    return `${ref.owner}/${ref.repo}`;
  }
  if (ref.platform === 'gitlab') {
    return ref.projectPath;
  }
  return `${ref.workspace}/${ref.repoSlug}`;
}

/** `group/sub/repo!12` on GitLab, `owner/repo#7` elsewhere — one row label. */
export function providerPrRefLabel(ref: ProviderPrRef): string {
  const separator = ref.platform === 'gitlab' ? '!' : '#';
  return `${providerPrRepoPath(ref)}${separator}${providerPrNumber(ref)}`;
}

/**
 * The `owner` / `repo` / `number` triple the existing GitHub-shaped
 * components and local stores are written against. Splitting the project
 * path at its LAST separator keeps `owner + '/' + repo` equal to the
 * provider's own path, so a nested GitLab group still renders in full.
 */
export type ProviderPrTriple = {
  owner: string;
  repo: string;
  number: number;
};

export function providerPrTriple(ref: ProviderPrRef): ProviderPrTriple {
  const path = providerPrRepoPath(ref);
  const cut = path.lastIndexOf('/');
  return {
    owner: cut === -1 ? path : path.slice(0, cut),
    repo: cut === -1 ? '' : path.slice(cut + 1),
    number: providerPrNumber(ref),
  };
}

/**
 * The provider's own web URL for this PR/MR, or null when it cannot be
 * built. A GitLab ref reached by a deep link may carry no instance hint, and
 * the hint is the only thing that names the host — guessing gitlab.com would
 * hand a self-managed user a link into a stranger's project.
 */
export function providerPrWebUrl(ref: ProviderPrRef): string | null {
  if (ref.platform === 'github') {
    return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
  }
  if (ref.platform === 'bitbucket') {
    return `https://bitbucket.org/${ref.workspace}/${ref.repoSlug}/pull-requests/${ref.prId}`;
  }
  if (!ref.instanceHint) {
    return null;
  }
  const base = ref.instanceHint.replace(/\/+$/, '');
  return `${base}/${ref.projectPath}/-/merge_requests/${ref.mrIid}`;
}

/**
 * The route segments for a ref: the platform plus the identity segments,
 * project path first and the number last.
 */
export type ProviderPrRouteSegments = {
  platform: ProviderPrPlatform;
  identity: string[];
};

export function providerPrRouteSegments(ref: ProviderPrRef): ProviderPrRouteSegments {
  return {
    platform: ref.platform,
    identity: [...providerPrRepoPath(ref).split('/'), String(providerPrNumber(ref))],
  };
}

/**
 * The navigable path for a ref. GitHub refs keep the original three-segment
 * route so that surface never changes; GitLab and Bitbucket go to the
 * provider route. A GitLab `instanceHint` rides as a query param because it
 * is display/matching only — the server re-derives the real instance.
 */
export function providerPrRoutePath(ref: ProviderPrRef): Href {
  return providerPrHref(ref, '');
}

/**
 * A screen that lives INSIDE the ref's own layout — today the file-navigator
 * sheet. It must be reached through the ref's own route: the provider scope
 * is published by the provider layout, so pushing the GitHub sibling from a
 * GitLab MR would leave that scope and query the wrong provider.
 */
type ProviderPrChildRoute = 'file-navigator';

export function providerPrChildRoutePath(ref: ProviderPrRef, child: ProviderPrChildRoute): Href {
  return providerPrHref(ref, `/${child}`);
}

function providerPrHref(ref: ProviderPrRef, suffix: string): Href {
  const { platform, identity } = providerPrRouteSegments(ref);
  const encoded = identity.map(segment => encodeURIComponent(segment)).join('/');
  if (ref.platform === 'github') {
    return `/(app)/pr-review/${encoded}${suffix}` as Href;
  }
  const query =
    ref.platform === 'gitlab' && ref.instanceHint
      ? `?instance=${encodeURIComponent(ref.instanceHint)}`
      : '';
  return `/(app)/pr-review/${platform}/${encoded}${suffix}${query}` as Href;
}

/**
 * Parse the provider route's params into a ref, or null when the deep link
 * is malformed. Every segment is validated here — a hand-built link can hand
 * a screen a missing segment, a repeated segment, or a non-numeric id, and
 * none of those may reach a query.
 *
 * GitLab and Bitbucket both need at least a two-segment project path plus
 * the number; Bitbucket is exactly `workspace/repo/id` because its API has
 * no nesting.
 */
export function parseProviderPrRoute(params: {
  platform: string | string[] | undefined;
  identity: string | string[] | undefined;
  instance?: string | string[] | undefined;
}): ProviderPrRef | null {
  const platform = parseParam(params.platform);
  if (!isProviderPrPlatform(platform)) {
    return null;
  }
  const segments = identitySegments(params.identity).map(segment => decodeSegment(segment));
  if (segments.some(segment => segment === null)) {
    return null;
  }
  const identity = segments as string[];
  const number = parsePositiveIntParam(identity.at(-1));
  if (number === null) {
    return null;
  }
  const path = identity.slice(0, -1);
  if (path.length < 2) {
    return null;
  }
  const [first, second] = path;
  if (platform === 'github' || platform === 'bitbucket') {
    if (path.length !== 2 || !first || !second) {
      return null;
    }
    return platform === 'github'
      ? githubPrRef(first, second, number)
      : { platform: 'bitbucket', workspace: first, repoSlug: second, prId: number };
  }
  const instanceHint = parseParam(params.instance) ?? undefined;
  return { platform: 'gitlab', projectPath: path.join('/'), mrIid: number, instanceHint };
}

/** A catch-all param arrives as an array, a single string, or nothing. */
function identitySegments(identity: string | string[] | undefined): string[] {
  if (Array.isArray(identity)) {
    return identity;
  }
  return identity ? [identity] : [];
}

/** A single route segment: present, non-empty, and decodable. */
function decodeSegment(segment: string): string | null {
  if (segment.length === 0) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 && !decoded.includes('/') ? decoded : null;
  } catch {
    // A malformed percent-escape in a hand-built deep link.
    return null;
  }
}

// ── the live scope ─────────────────────────────────────────────────────
// The ref alone does not say which organization a provider call runs under,
// and the URL cannot carry one. The scope pairs them and travels in context
// so the diff, navigator and discussion trees — which take the GitHub-shaped
// triple — keep their props while their queries follow the real provider.

/** Ref plus the organization the provider call must run under. */
export type ProviderPrScope = {
  readonly ref: ProviderPrRef;
  /** The selected organization, or null for the personal scope. */
  readonly organizationId: string | null;
};

const ProviderPrScopeContext = createContext<ProviderPrScope | null>(null);

/**
 * Publish the scope to every surface below. Mounted by the provider route;
 * the GitHub route never mounts it, so GitHub keeps the exact query path it
 * had before this slice.
 */
export function ProviderPrScopeProvider({
  value,
  children,
}: Readonly<{ value: ProviderPrScope; children: ReactNode }>) {
  return createElement(ProviderPrScopeContext.Provider, { value }, children);
}

/**
 * The live scope. Falls back to the GitHub triple the caller already has,
 * which is what every component below the GitHub route passes.
 */
export function useProviderPrScope(fallback: ProviderPrTriple): ProviderPrScope {
  const context = useContext(ProviderPrScopeContext);
  const { owner, repo, number } = fallback;
  return useMemo(
    () => context ?? { ref: githubPrRef(owner, repo, number), organizationId: null },
    [context, owner, repo, number]
  );
}

/**
 * The live scope, or null when no provider route is above this component —
 * which is the GitHub route, since only the provider layout mounts the
 * scope provider. Recovery affordances (the reconnect notice) use it to
 * check the right provider's connection without inventing a GitHub identity
 * for a GitLab or Bitbucket surface.
 */
export function useProviderPrScopeOrNull(): ProviderPrScope | null {
  return useContext(ProviderPrScopeContext);
}

export function providerPrCapabilities(platform: ProviderPrPlatform): ProviderReviewCapabilities {
  return PROVIDER_REVIEW_CAPABILITIES[platform];
}

/**
 * Bitbucket Cloud is organization-context only, so a scope without an
 * organization cannot be queried at all. GitHub and GitLab work personally.
 */
export function isProviderScopeReady(scope: ProviderPrScope): boolean {
  return scope.ref.platform !== 'bitbucket' || scope.organizationId !== null;
}
