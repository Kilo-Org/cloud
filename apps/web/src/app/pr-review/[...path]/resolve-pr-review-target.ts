import { z } from 'zod';

// The web has no PR review surface: review lives in the mobile app, and the
// universal links in `@kilocode/app-shared/universal-links` claim these paths
// for it. A desktop visitor — or a phone without the app — gets the same
// review by going to the provider's own page, so every shape the app claims is
// mapped here to the provider URL it names.
//
// Path shapes, mirroring `parseProviderPrRoute` in the mobile app:
//   /pr-review/<owner>/<repo>/<number>                     GitHub
//   /pr-review/gitlab/<group>.../<repo>/<number>?instance= GitLab (self-managed aware)
//   /pr-review/bitbucket/<workspace>/<repo>/<id>           Bitbucket Cloud
// A trailing child route the app embeds (`/file-navigator`, `/merge`) lands on
// the review itself. Anything else is malformed and must not redirect.

/** Where a `/pr-review/...` request should send the visitor, or null for 404. */
export type PrReviewTarget =
  /** Provider page this path names; redirect to it as-is. */
  | { readonly kind: 'redirect'; readonly url: string }
  /**
   * A self-managed GitLab instance whose host cannot be verified from the
   * URL alone. The page shows the link; it must never auto-navigate, or a
   * crafted `?instance=` would turn this route into an open redirect.
   */
  | {
      readonly kind: 'confirm';
      readonly url: string;
      readonly host: string;
    };

export const PR_REVIEW_REDIRECT_STATUS = 307;

const GITHUB_HOST = 'github.com';
const BITBUCKET_HOST = 'bitbucket.org';
const GITLAB_PLATFORM = 'gitlab';
const BITBUCKET_PLATFORM = 'bitbucket';

const MAX_PATH_SEGMENTS = 64;

/**
 * A provider path segment. The first character must be alphanumeric, which is
 * what keeps `@evil.com`, `..`, `.` and a bare `-` out of the built URL.
 */
const segmentSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/**
 * GitHub's own owner shape: alphanumeric with single hyphens, 39 characters
 * max, no trailing hyphen. A hostname (`evil.com`) never validates as one.
 */
const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);

/** A PR number / MR iid / PR id: digits only, no sign, no leading zero. */
const reviewNumberSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/)
  .transform(value => Number(value));

const pathSchema = z.array(z.unknown()).min(1).max(MAX_PATH_SEGMENTS);

/** `scheme://host[:port]`, with nothing after the port. */
const instanceUrlSchema = z
  .string()
  .max(255)
  .regex(/^(?:https?):\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/);

const hostLabelSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);

type ParsedOrigin = {
  /** Lowercased scheme. */
  scheme: 'http' | 'https';
  /** Lowercased `host[:port]`. */
  authority: string;
};

/**
 * A route param as one validated segment, or null. Next decodes catch-all
 * params, so a `%2F` in the request path arrives as a `/` here and fails the
 * segment pattern rather than splitting the URL we build.
 */
function parseSegment(value: unknown): string | null {
  const parsed = segmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The last segment that is a review number, dropping a trailing child route. */
function splitTrailingNumber(segments: readonly string[]): {
  head: string[];
  number: number;
} | null {
  const last = reviewNumberSchema.safeParse(segments.at(-1));
  if (last.success) {
    return { head: segments.slice(0, -1), number: last.data };
  }
  // A child route the app embeds, e.g. `.../42/file-navigator`.
  if (segments.length < 2) {
    return null;
  }
  const penultimate = reviewNumberSchema.safeParse(segments.at(-2));
  if (!penultimate.success) {
    return null;
  }
  return { head: segments.slice(0, -2), number: penultimate.data };
}

/** A strict `scheme://host[:port]` origin, or null. */
function parseOrigin(raw: string): ParsedOrigin | null {
  const parsed = instanceUrlSchema.safeParse(raw.trim());
  if (!parsed.success) {
    return null;
  }
  const match = /^(https?):\/\/([^:]+)(?::(\d{1,5}))?$/.exec(parsed.data);
  if (!match) {
    return null;
  }
  const [, scheme, host, port] = match;
  if (scheme !== 'http' && scheme !== 'https') {
    return null;
  }
  if (!host) {
    return null;
  }
  const labels = host.split('.');
  // A single-label host is an intranet name: never auto-navigated to, and not
  // a shape we show a link to either. Two labels minimum means a real DNS name.
  if (labels.length < 2 || !labels.every(label => hostLabelSchema.safeParse(label).success)) {
    return null;
  }
  const authority = port ? `${host}:${port}` : host;
  return { scheme, authority: authority.toLowerCase() };
}

/**
 * The GitLab origin a request names. Absent means gitlab.com — the mobile
 * link builder only adds `?instance=` for a self-managed host.
 */
function resolveGitLabOrigin(instance: string | null): ParsedOrigin | null {
  if (instance === null) {
    return { scheme: 'https', authority: 'gitlab.com' };
  }
  return parseOrigin(instance);
}

function encoded(path: readonly string[]): string {
  return path.map(segment => encodeURIComponent(segment)).join('/');
}

function githubTarget(head: readonly string[], number: number): PrReviewTarget | null {
  if (head.length !== 2) {
    return null;
  }
  const [owner, repo] = head;
  if (owner === undefined || repo === undefined) {
    return null;
  }
  if (!githubOwnerSchema.safeParse(owner).success) {
    return null;
  }
  return {
    kind: 'redirect',
    url: `https://${GITHUB_HOST}/${encoded([owner, repo])}/pull/${number}`,
  };
}

function bitbucketTarget(head: readonly string[], prId: number): PrReviewTarget | null {
  if (head.length !== 2) {
    return null;
  }
  const [workspace, repo] = head;
  if (workspace === undefined || repo === undefined) {
    return null;
  }
  return {
    kind: 'redirect',
    url: `https://${BITBUCKET_HOST}/${encoded([workspace, repo])}/pull-requests/${prId}`,
  };
}

function gitlabTarget(
  head: readonly string[],
  mrIid: number,
  instance: string | null
): PrReviewTarget | null {
  // GitLab names a project with at least a group and the project itself.
  if (head.length < 2) {
    return null;
  }
  const origin = resolveGitLabOrigin(instance);
  if (origin === null) {
    return null;
  }
  const projectPath = encoded(head);
  const url = `${origin.scheme}://${origin.authority}/${projectPath}/-/merge_requests/${mrIid}`;
  if (origin.scheme === 'https' && origin.authority === 'gitlab.com') {
    return { kind: 'redirect', url };
  }
  // A self-managed host arrives in the query, so it is caller-controlled. The
  // URL is well formed, but only the visitor may decide to follow it.
  return { kind: 'confirm', url, host: origin.authority };
}

/**
 * Map a `/pr-review/[...path]` request onto the provider page it names.
 *
 * Returns null for anything malformed: an unknown platform, a missing or
 * repeated segment, a non-numeric id, a project path GitLab could not name, or
 * an `instance` that is not a plain `scheme://host[:port]` origin.
 */
export function resolvePrReviewTarget(input: {
  path: readonly unknown[];
  instance: string | null;
}): PrReviewTarget | null {
  const path = pathSchema.safeParse(input.path);
  if (!path.success) {
    return null;
  }
  const segments: string[] = [];
  for (const raw of path.data) {
    const segment = parseSegment(raw);
    if (segment === null) {
      return null;
    }
    segments.push(segment);
  }

  const [first, ...rest] = segments;
  if (first === undefined) {
    return null;
  }

  if (first === GITLAB_PLATFORM) {
    const split = splitTrailingNumber(rest);
    return split === null ? null : gitlabTarget(split.head, split.number, input.instance);
  }
  if (first === BITBUCKET_PLATFORM) {
    const split = splitTrailingNumber(rest);
    return split === null ? null : bitbucketTarget(split.head, split.number);
  }
  const split = splitTrailingNumber(segments);
  return split === null ? null : githubTarget(split.head, split.number);
}
