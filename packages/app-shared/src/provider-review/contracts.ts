/**
 * Provider-discriminated identity and DTO contracts for the PR/MR review
 * layer (GitHub, GitLab, Bitbucket).
 *
 * This module is pure vocabulary: the provider types plus two pure key
 * helpers, `providerPrRefKey` and `gitlabInstanceOrigin`. The helpers only
 * build and fold strings; they perform no I/O and hold no state, so identity
 * normalization belongs here rather than in a mapper. The server mappers
 * (s2–s4), the router, and the mobile presentation all derive their shapes
 * from here, so a provider difference never leaks past its mapper.
 */

import type { CodeReviewPlatform } from '../code-review/enums';

/**
 * The provider platforms the PR/MR review layer supports. Derived from the
 * package's canonical `CodeReviewPlatform` so one vocabulary cannot drift from
 * the other; the values are `github`, `gitlab`, `bitbucket`.
 */
export type ProviderPrPlatform = CodeReviewPlatform;

/** A GitHub pull request: the `owner/repo#number` triple the mobile tree already routes on. */
export type GitHubPrRef = {
  platform: 'github';
  owner: string;
  repo: string;
  number: number;
};

/**
 * A GitLab merge request. `projectPath` is the FULL nested path, e.g.
 * `group/sub/repo` — never just the last segment. `instanceHint` identifies
 * which GitLab instance the user connected; it is display/matching only and
 * MUST never be used as an API base.
 */
export type GitLabMrRef = {
  platform: 'gitlab';
  projectPath: string;
  mrIid: number;
  instanceHint?: string;
};

/** A Bitbucket Cloud pull request: `workspace/repoSlug` plus the numeric `prId`. */
export type BitbucketPrRef = {
  platform: 'bitbucket';
  workspace: string;
  repoSlug: string;
  prId: number;
};

export type ProviderPrRef = GitHubPrRef | GitLabMrRef | BitbucketPrRef;

/**
 * The canonical cache/draft/recents key for one ref.
 *
 * The key folds the platform tag, the GitLab instance origin, and the
 * Bitbucket workspace/repository identity into a JSON array, so two
 * same-named repositories on different providers (or on different GitLab
 * instances) can never collide: JSON escaping keeps each array element
 * unambiguous, and the leading platform tag keeps the namespaces apart.
 *
 * Identity fields are used as the provider returned them. Only the instance
 * origin is normalized (hostnames are case-insensitive per DNS); repository
 * paths are NOT case-folded, because a self-managed instance may treat two
 * casings as distinct and a miss is safe while a collision is not.
 */
export function providerPrRefKey(ref: ProviderPrRef): string {
  switch (ref.platform) {
    case 'github':
      return JSON.stringify(['github', ref.owner, ref.repo, ref.number]);
    case 'gitlab':
      return JSON.stringify([
        'gitlab',
        gitlabInstanceOrigin(ref.instanceHint),
        ref.projectPath,
        ref.mrIid,
      ]);
    case 'bitbucket':
      return JSON.stringify(['bitbucket', ref.workspace, ref.repoSlug, ref.prId]);
  }
}

/**
 * The normalized origin of a GitLab `instanceHint` for identity folding:
 * scheme, path, and query are dropped, the host is lowercased, and the port
 * is kept (an instance on another port is another instance). An absent hint
 * folds to `''` — deliberately NOT equal to `'gitlab.com'`, so a ref without
 * a hint can never collide with one pinned to the SaaS host.
 */
export function gitlabInstanceOrigin(instanceHint?: string): string {
  if (!instanceHint) return '';
  let rest = instanceHint.trim().toLowerCase();
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) rest = rest.slice(scheme[0].length);
  return (rest.split('/')[0] ?? '').split('?')[0] ?? '';
}

/** An author or reviewer identity. `login` is the provider username. */
export type ProviderPrAuthor = {
  login: string;
  avatarUrl: string | null;
};

/** The lifecycle state every provider maps onto. */
export type ProviderPrState = 'open' | 'closed' | 'merged';

/** Which side of a diff a comment or thread anchors to. */
export type ProviderPrDiffSide = 'LEFT' | 'RIGHT';

/**
 * The diff position one inline review comment anchors to. `line` is the
 * anchor line on `side`; `startLine` marks the first line of a multi-line
 * range (GitHub parity: GitLab diff discussions and Bitbucket inline
 * comments both accept this shape).
 */
export type ProviderReviewInlineAnchor = {
  path: string;
  side: ProviderPrDiffSide;
  line: number;
  startLine?: number;
};

/** One inline comment inside a review submission batch. */
export type ProviderReviewInlineComment = ProviderReviewInlineAnchor & {
  body: string;
};

/**
 * One PR/MR as the review screen renders it. Field shapes mirror what the
 * mobile tree consumes today from `githubPrReview` (title, author, state,
 * head/target refs, headSha, changedFiles, additions, deletions, body,
 * webUrl); the ref is always carried so every surface keys by provider.
 */
export type ProviderPrSummary = {
  ref: ProviderPrRef;
  title: string;
  /** Markdown body, or null when the provider has none. */
  body: string | null;
  author: ProviderPrAuthor | null;
  state: ProviderPrState;
  draft: boolean;
  /** The source branch (head) the change comes from. */
  headRef: string;
  /** The target branch (base) the change merges into. */
  baseRef: string;
  /** The head commit sha — the fence every write intent compares against. */
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** The provider's canonical web URL for this PR/MR. */
  webUrl: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The change vocabulary the review UI renders, closed on purpose: every
 * provider word maps into this set, so the presentation never prints a token
 * it cannot translate. `removed` is the one word for a deletion (GitHub sends
 * `removed`, GitLab `deleted`); `unknown` is the explicit bucket for a word no
 * mapper recognises, and the rows give it a generic label of their own.
 */
export type ProviderPrFileStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unknown';

/** The normalized status for one provider word: `deleted` is `removed`, anything unrecognised is `unknown`. */
export function providerPrFileStatus(raw: string | null | undefined): ProviderPrFileStatus {
  switch (raw) {
    case 'added':
    case 'removed':
    case 'modified':
    case 'renamed':
    case 'copied':
    case 'changed':
      return raw;
    case 'deleted':
      return 'removed';
    default:
      return 'unknown';
  }
}

/**
 * Why a changed file has no patch to show. Each cause earns its own copy: the
 * file is binary, the provider dropped an oversized patch, the read's endpoint
 * carries no patch at all, or the file changed without changing its content
 * (a mode or rename-only change), so there is nothing to diff.
 */
export type ProviderPrFilePatchMissingCause =
  | 'binary'
  | 'too_large'
  | 'provider_omitted'
  | 'content_unchanged';

/**
 * One changed file in the files page.
 *
 * `status` is the closed display vocabulary above; each mapper maps the
 * provider's own word through `providerPrFileStatus`, so a word the UI has no
 * label for arrives as `unknown` instead of leaking through.
 *
 * `patch` is the unified diff the provider returned for the file, or null
 * when it returned none.
 *
 * `patchMissingCause` names WHY there is no patch, or null when the read
 * carried one. It is the mapper's answer, not a derivation the presentation
 * repeats: GitHub drops the patch for binary files and for oversized ones and
 * reports binary files with zero line counts, GitLab returns an empty diff for
 * a binary file, and Bitbucket's diffstat endpoint never carries a patch. A
 * non-null cause always comes with `patch === null`; a null cause can still
 * parse to zero hunks, which the rows answer as "no preview".
 */
export type ProviderPrFile = {
  path: string;
  previousPath: string | null;
  status: ProviderPrFileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
  patchMissingCause: ProviderPrFilePatchMissingCause | null;
};

/**
 * One page of changed files. `nextCursor` is an opaque provider string
 * (GitLab pages tokens, Bitbucket page params, GitHub cursors all fold in);
 * null means the last page.
 */
export type ProviderPrFilesPage = {
  files: ProviderPrFile[];
  nextCursor: string | null;
};

/** One comment in a discussion thread. `commentId` is a string because provider ids are not all numeric. */
export type ProviderPrComment = {
  commentId: string;
  author: ProviderPrAuthor | null;
  body: string;
  createdAt: string;
};

/**
 * One inline discussion thread. Anchors (`path`, `line`, `side`) are null for
 * threads the provider does not pin to a diff position.
 */
export type ProviderPrThread = {
  threadId: string;
  resolved: boolean;
  path: string | null;
  line: number | null;
  side: ProviderPrDiffSide | null;
  comments: ProviderPrComment[];
};

export type ProviderPrThreadsPage = {
  threads: ProviderPrThread[];
  nextCursor: string | null;
};

/**
 * One CI check on the PR/MR. `status` is the provider's run state and
 * `conclusion` its final verdict — both kept as strings because every
 * provider has its own vocabulary the mapper passes through.
 */
export type ProviderPrCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
};

export type ProviderPrChecksResult = {
  checks: ProviderPrCheck[];
};

/**
 * Why a merge is blocked right now. `code` is the stable machine id the
 * presentation renders catalog copy from — one key per code, in the reader's
 * language. `message` is the provider's own text (or the mapper's English
 * sentence) and is secondary detail only: a surface that shows it shows it
 * beside the localized copy, never instead of it. `other` is the explicit
 * unknown bucket, and it is the only code whose `message` may say something
 * the copy cannot.
 */
export type ProviderPrMergeBlockedReason = {
  code:
    | 'conflicts'
    | 'required_approvals'
    | 'failing_pipeline'
    | 'pending_pipeline'
    | 'draft'
    | 'not_open'
    | 'unresolved_discussions'
    | 'unresolved_tasks'
    | 'permission'
    | 'other';
  message: string;
};

/**
 * The merge gate for one PR/MR: the branch policy (`approvalsRequired`,
 * `pipelineMustSucceed`), the conflict flag, and the concrete list of what
 * blocks merging right now.
 */
export type ProviderPrMergeState = {
  canMerge: boolean;
  /** How many approvals the policy requires; 0 when the provider has no approval gate. */
  approvalsRequired: number;
  /** Whether a succeeding pipeline is required before merging. */
  pipelineMustSucceed: boolean;
  conflicts: boolean;
  blockedReasons: ProviderPrMergeBlockedReason[];
};

/**
 * One inbox row. It ALWAYS carries its `ProviderPrRef`, so the list, the
 * cache key, and the navigation target can never disagree about which
 * provider's repo the row points at.
 */
export type ProviderPrInboxItem = {
  ref: ProviderPrRef;
  title: string;
  author: ProviderPrAuthor | null;
  state: ProviderPrState;
  draft: boolean;
  updatedAt: string;
};

export type ProviderPrInboxPage = {
  items: ProviderPrInboxItem[];
  nextCursor: string | null;
};
