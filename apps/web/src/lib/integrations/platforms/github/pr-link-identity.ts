/**
 * Pure helpers that decide whether a session's stored pull-request link
 * verifiably names a GitHub pull request.
 *
 * A wrong link is worse than no link, so the only accepted evidence is a
 * stored link that the session itself reported plus GitHub facts that agree
 * with it:
 *
 *   - the PR URL stored on the session names the session's repository
 *     (host + owner + name, case-insensitive), and
 *   - the PR's base repository is that same repository, and
 *   - the PR's head repository is that same repository (a fork or another
 *     repo that happens to share the branch name never matches), and
 *   - the PR's head ref is the session's branch, and
 *   - when the session reported a head SHA, GitHub reports that SHA as the PR
 *     head or as one of the PR's commits.
 *
 * A branch name (with repo and tenant) is never on its own enough to link a
 * PR: without a session-reported link there is no candidate, and without a
 * session head SHA the repo + head repo + head ref checks above still have to
 * pass.
 *
 * Everything here is pure so it can be shared by ingest-time validation, the
 * refresh path, and tests without I/O.
 */

const FALLBACK_HOST = 'github.com';

/** A repository reference reduced to a comparison key. */
export type NormalizedRepo = {
  /** Lower-cased host, for example `github.com`. */
  host: string;
  /** Lower-cased owner (user or organization). */
  owner: string;
  /** Lower-cased repository name. */
  repo: string;
  /** `owner/repo`, lower-cased. */
  fullName: string;
  /** Canonical `https://host/owner/repo`. */
  url: string;
  /** `${host}/${owner}/${repo}`, lower-cased. The comparison key. */
  key: string;
};

export type ParsedPullRequestUrl = {
  host: string;
  owner: string;
  repo: string;
  /** PR number parsed from the URL. */
  number: number;
  /** Canonical `https://host/owner/repo`. */
  repoUrl: string;
};

const PULL_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i;

function buildRepo(host: string, rawPath: string): NormalizedRepo | null {
  const path = rawPath
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    // Drop a trailing PR/issue suffix if a full PR URL slipped through.
    .replace(/\/pull\/\d+(?:\/.*)?$/i, '');
  const withoutLeading = path.replace(/^\/+/, '');
  const segments = withoutLeading.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[segments.length - 2].toLowerCase();
  const repo = segments[segments.length - 1].toLowerCase();
  const normalizedHost = (host || FALLBACK_HOST).toLowerCase();
  if (!owner || !repo) return null;

  return {
    host: normalizedHost,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    url: `https://${normalizedHost}/${owner}/${repo}`,
    key: `${normalizedHost}/${owner}/${repo}`,
  };
}

/**
 * Parse a repository reference — a clone URL (`https`, `ssh`, `git@` SCP
 * form, with or without `.git`), an `owner/repo` full name, a `host/owner/repo`
 * path, or a pull-request URL — into a canonical, case-insensitive reference.
 *
 * Returns `null` when no owner/repo can be extracted, so callers can treat an
 * unparseable value as "no evidence" rather than guessing.
 */
export function parseRepoReference(value: string | null | undefined): NormalizedRepo | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  // SCP-style clone URL: git@github.com:owner/repo.git
  const scp = raw.match(/^([^@\s/]+)@([^:/\s]+):(.+)$/);
  if (scp) {
    return buildRepo(scp[2], scp[3]);
  }

  if (raw.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    return buildRepo(parsed.hostname, parsed.pathname);
  }

  // No scheme. Either `owner/repo`, `host/owner/repo`, or a PR URL path.
  const parts = raw
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (parts.length === 2) {
    return buildRepo(FALLBACK_HOST, parts.join('/'));
  }
  if (parts.length >= 3) {
    // `github.com/owner/repo` or `.../owner/repo/pull/123`.
    return buildRepo(parts[0], parts.slice(1).join('/'));
  }
  return null;
}

/**
 * Normalize any repo/PR reference to canonical `https://host/owner/repo`, or
 * `null` when it cannot be parsed. Never throws.
 */
export function normalizeRepoUrl(value: string | null | undefined): string | null {
  return parseRepoReference(value)?.url ?? null;
}

/** True when two repo references name the same host + owner + repo. */
export function repoReferencesMatch(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = parseRepoReference(a);
  const right = parseRepoReference(b);
  return left !== null && right !== null && left.key === right.key;
}

/**
 * True when a stored pull-request URL names the given repository. Used at
 * ingest to reject a `session_pr_link`/heartbeat `prLink` whose owner/repo does
 * not match the session's `git_url`.
 */
export function pullRequestUrlMatchesRepo(
  prUrl: string | null | undefined,
  repoUrl: string | null | undefined
): boolean {
  const parsed = parsePullRequestUrl(prUrl);
  return parsed !== null && repoReferencesMatch(parsed.repoUrl, repoUrl);
}

/**
 * Parse `https://host/owner/repo/pull/123` (or the same without a scheme) into
 * its repository reference and PR number. Returns `null` for anything that is
 * not a pull-request URL.
 */
export function parsePullRequestUrl(value: string | null | undefined): ParsedPullRequestUrl | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    // Preserve both `host/owner/repo/pull/123` and `owner/repo/pull/123`.
    const url = raw.includes('://')
      ? raw
      : /^[^/?#]+\/[^/?#]+\/pull\//i.test(raw)
        ? `https://${FALLBACK_HOST}/${raw}`
        : `https://${raw}`;
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(PULL_PATH_RE);
  if (!match) return null;

  const repoRef = buildRepo(parsed.hostname, `${match[1]}/${match[2]}`);
  if (!repoRef) return null;

  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return {
    host: repoRef.host,
    owner: repoRef.owner,
    repo: repoRef.repo,
    number,
    repoUrl: repoRef.url,
  };
}

/** What the session itself reported about its PR link. */
export type SessionPullRequestLink = {
  /** `cli_sessions_v2.pr_url` / `session_pr_link.prUrl`. */
  prUrl?: string | null;
  /** `cli_sessions_v2.pr_number` / `session_pr_link.prNumber`. */
  prNumber?: number | null;
  /** `session_pr_link.headRef`: the branch the session pushed. */
  headRef?: string | null;
  /** `session_pr_link.headSha`: the commit the session pushed to that branch. */
  headSha?: string | null;
};

/** The session's repository identity. */
export type SessionRepoRef = {
  /** `cli_sessions_v2.git_url`. */
  gitUrl?: string | null;
  /** `cli_sessions_v2.git_branch`. */
  gitBranch?: string | null;
};

/**
 * The GitHub facts about a PR, as returned by `fetchPullRequestByNumber`.
 * `commitShas` is `undefined`/`null` when the caller did not request commits.
 */
export type PullRequestFacts = {
  number: number;
  baseRepoFullName?: string | null;
  headRepoFullName?: string | null;
  headRef?: string | null;
  headSha?: string | null;
  commitShas?: readonly string[] | null;
};

export type PullRequestLinkRejectionReason =
  | 'missing_session_repo'
  | 'missing_pr_url'
  | 'pr_url_not_session_repo'
  | 'pr_number_mismatch'
  | 'base_repo_mismatch'
  | 'head_repo_mismatch'
  | 'head_ref_mismatch'
  | 'head_sha_mismatch';

export type PullRequestLinkVerification =
  | {
      verified: true;
      /** Which piece of evidence carried the decision. */
      evidence: 'head_sha' | 'commit_sha' | 'head_ref';
    }
  | { verified: false; reason: PullRequestLinkRejectionReason };

function reject(reason: PullRequestLinkRejectionReason): PullRequestLinkVerification {
  return { verified: false, reason };
}

function normalizeSha(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Decide whether `pullRequest` verifiably is the PR that the session's stored
 * link/head fields name. See the module comment for the evidence contract.
 */
export function verifySessionPullRequestLink(args: {
  sessionRepo: SessionRepoRef;
  link: SessionPullRequestLink;
  pullRequest: PullRequestFacts;
}): PullRequestLinkVerification {
  const { sessionRepo, link, pullRequest } = args;

  const sessionRepoRef = parseRepoReference(sessionRepo.gitUrl);
  if (!sessionRepoRef) {
    return reject('missing_session_repo');
  }

  // The link has to be the one this session reported, and it has to name the
  // session's repository. A branch-name match alone is never a candidate.
  if (!link.prUrl) {
    return reject('missing_pr_url');
  }
  const linkRepoRef = parseRepoReference(link.prUrl);
  if (!linkRepoRef || linkRepoRef.key !== sessionRepoRef.key) {
    return reject('pr_url_not_session_repo');
  }

  if (link.prNumber != null && link.prNumber !== pullRequest.number) {
    return reject('pr_number_mismatch');
  }

  // Base repository must be the session's repository.
  const baseRepoRef = parseRepoReference(pullRequest.baseRepoFullName);
  if (!baseRepoRef || baseRepoRef.key !== sessionRepoRef.key) {
    return reject('base_repo_mismatch');
  }

  // Head repository must be the same repository: a fork or another repo with
  // the same branch name never matches.
  const headRepoRef = parseRepoReference(pullRequest.headRepoFullName);
  if (!headRepoRef || headRepoRef.key !== sessionRepoRef.key) {
    return reject('head_repo_mismatch');
  }

  // PR head ref must equal the session's branch, and the branch the session
  // reported pushing when it differs from the stored branch.
  const expectedRefs = new Set<string>();
  if (sessionRepo.gitBranch) expectedRefs.add(sessionRepo.gitBranch);
  if (link.headRef) expectedRefs.add(link.headRef);
  if (expectedRefs.size === 0 || !pullRequest.headRef) {
    return reject('head_ref_mismatch');
  }
  for (const expectedRef of expectedRefs) {
    if (pullRequest.headRef !== expectedRef) {
      return reject('head_ref_mismatch');
    }
  }

  const sessionHeadSha = normalizeSha(link.headSha);
  if (sessionHeadSha) {
    // With a head SHA, GitHub must confirm it as the PR head or one of the PR's
    // commits. Without the commit list we cannot confirm a non-head SHA, so a
    // mismatch is rejected rather than assumed.
    const prHeadSha = normalizeSha(pullRequest.headSha);
    if (prHeadSha && prHeadSha === sessionHeadSha) {
      return { verified: true, evidence: 'head_sha' };
    }
    const commitShas = pullRequest.commitShas;
    if (commitShas && commitShas.some(sha => normalizeSha(sha) === sessionHeadSha)) {
      return { verified: true, evidence: 'commit_sha' };
    }
    return reject('head_sha_mismatch');
  }

  // Older CLI without a head SHA: repo + head repo + head ref are the strongest
  // evidence available, and they must all hold. Never branch alone.
  return { verified: true, evidence: 'head_ref' };
}

/** Convenience boolean form of {@link verifySessionPullRequestLink}. */
export function isSessionPullRequestLinkVerified(args: {
  sessionRepo: SessionRepoRef;
  link: SessionPullRequestLink;
  pullRequest: PullRequestFacts;
}): boolean {
  return verifySessionPullRequestLink(args).verified;
}
