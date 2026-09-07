/**
 * Provider-discriminated identity and DTO contracts for the PR/MR review
 * layer (GitHub, GitLab, Bitbucket).
 *
 * This module is pure vocabulary: types plus one canonical key function.
 * No behavior, no I/O. The server mappers (s2–s4), the router, and the
 * mobile presentation all derive their shapes from here, so a provider
 * difference never leaks past its mapper.
 */

export type ProviderPrPlatform = "github" | "gitlab" | "bitbucket";

/** A GitHub pull request: the `owner/repo#number` triple the mobile tree already routes on. */
export type GitHubPrRef = {
  platform: "github";
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
  platform: "gitlab";
  projectPath: string;
  mrIid: number;
  instanceHint?: string;
};

/** A Bitbucket Cloud pull request: `workspace/repoSlug` plus the numeric `prId`. */
export type BitbucketPrRef = {
  platform: "bitbucket";
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
    case "github":
      return JSON.stringify(["github", ref.owner, ref.repo, ref.number]);
    case "gitlab":
      return JSON.stringify([
        "gitlab",
        gitlabInstanceOrigin(ref.instanceHint),
        ref.projectPath,
        ref.mrIid,
      ]);
    case "bitbucket":
      return JSON.stringify([
        "bitbucket",
        ref.workspace,
        ref.repoSlug,
        ref.prId,
      ]);
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
  if (!instanceHint) return "";
  let rest = instanceHint.trim().toLowerCase();
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) rest = rest.slice(scheme[0].length);
  return (rest.split("/")[0] ?? "").split("?")[0] ?? "";
}

/** An author or reviewer identity. `login` is the provider username. */
export type ProviderPrAuthor = {
  login: string;
  avatarUrl: string | null;
};

/** The lifecycle state every provider maps onto. */
export type ProviderPrState = "open" | "closed" | "merged";

/** Which side of a diff a comment or thread anchors to. */
export type ProviderPrDiffSide = "LEFT" | "RIGHT";

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

/** One changed file in the files page. `patch` is null when the provider omits it. */
export type ProviderPrFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  patchMissing: boolean;
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

/** One page of discussion threads. */
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

/** The checks rollup for one PR/MR. */
export type ProviderPrChecksResult = {
  checks: ProviderPrCheck[];
};

/**
 * Why a merge is blocked right now. `code` is the stable machine id the
 * presentation picks an icon and a layout from; `message` is the
 * human-readable provider text.
 */
export type ProviderPrMergeBlockedReason = {
  code:
    | "conflicts"
    | "required_approvals"
    | "failing_pipeline"
    | "pending_pipeline"
    | "draft"
    | "permission"
    | "other";
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

/** One page of inbox rows. */
export type ProviderPrInboxPage = {
  items: ProviderPrInboxItem[];
  nextCursor: string | null;
};
