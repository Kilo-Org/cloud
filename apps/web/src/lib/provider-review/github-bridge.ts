import 'server-only';

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { operation_ledgers } from '@kilocode/db/schema';
import {
  normalizeLegacyGitHubReviewRepository,
  repositoryResourceKey,
  type GitHubUserAuthorization,
} from '@kilocode/app-shared/code-review/repository-identity';
import {
  ReviewActionSchema,
  ReviewCapabilitiesSchema,
  ReviewRevisionSchema,
  reviewActionAvailability,
  parseReviewCursor,
  reviewPageKey,
  reviewResourceKey,
  type ReviewActor,
  type ReviewCapability,
  type ReviewCursor,
  type ReviewFile,
  type ReviewFileContext,
  type ReviewInbox,
  type ReviewIntent,
  type ReviewMutationResult,
  type ReviewOverview,
  type ReviewPage,
  type ReviewPosition,
  type ReviewThread,
} from '@kilocode/app-shared/provider-review';
import type { TRPCContext } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
// Old GitHub procedures, DTOs, and ledger bytes stay behind this bridge until old
// clients/records disappear and the 30-day ledger window expires.
import {
  fetchGitHubReviewChecks,
  githubPrReviewRouter,
  prLedgerResourceKey,
} from '@/routers/github-pr-review-router';
import { buildChecksResult } from '@/lib/github-pr-review/mappers';
import type { PrLedgerIntent } from '@kilocode/app-shared/pr-review';
import type { GitHubPrReviewOverview } from '@/lib/github-pr-review/dtos';
import { withGitHubReviewIdentity, withGitHubUserTokenRetry } from '@/lib/github-pr-review/retry';
import { getGitHubUserAccessToken } from '@/lib/integrations/platforms/github/user-token-client';
import {
  AutoMergeMethodSchema,
  CommentPositionSchema,
  MergeMethodSchema,
  ReactionContentSchema,
} from '@/lib/github-pr-review/mutations';

export const GitHubReviewAddressSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive().safe(),
});
type Address = z.infer<typeof GitHubReviewAddressSchema>;
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const repositorySchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  default_branch: z.string().nullable().optional(),
});
const pullSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  head: z.object({ sha, repo: repositorySchema.nullish() }),
  base: z.object({ sha: sha.optional(), repo: repositorySchema }),
});
const reconnect = () =>
  new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'GitHub connection is no longer valid — reconnect',
  });
const conflict = () =>
  new TRPCError({ code: 'CONFLICT', message: 'review_identity_or_revision_changed' });

function author(value: GitHubPrReviewOverview['author']): ReviewActor | null {
  // Old author DTOs contain only login/avatar. Keep the qualified login fallback until
  // old clients/records disappear and the 30-day ledger window expires.
  return value
    ? {
        provider: 'github',
        instanceUrl: 'https://github.com',
        id: `login:${value.login.toLowerCase()}`,
        login: value.login,
        displayName: null,
        avatarUrl: z.url({ protocol: /^https$/ }).safeParse(value.avatarUrl).success
          ? value.avatarUrl
          : null,
      }
    : null;
}
function address(overview: ReviewOverview): Address {
  const [owner, repo] = overview.identity.repository.fullName.split('/');
  return GitHubReviewAddressSchema.parse({ owner, repo, number: Number(overview.identity.number) });
}
function sameRevision(expected: ReviewIntent['revision'], actual: ReviewIntent['revision']) {
  if (
    JSON.stringify(ReviewRevisionSchema.parse(expected)) !==
    JSON.stringify(ReviewRevisionSchema.parse(actual))
  )
    throw conflict();
}
function capabilities(value: GitHubPrReviewOverview) {
  const base: ReviewCapability = {
    support: 'supported',
    version: 'available',
    license: 'available',
    permission: 'allowed',
    restrictions: [],
    explanation: '',
    recovery: 'none',
    evidenceUrl: null,
    expectedHeadProtection: 'none',
  };
  return ReviewCapabilitiesSchema.parse(
    Object.fromEntries(
      ReviewActionSchema.options.map(action => {
        const capability = { ...base, restrictions: [] as string[] };
        if (['unapprove', 'removeChangeRequest'].includes(action)) {
          capability.support = 'unknown';
          capability.explanation = 'review_state_action_not_exposed';
          capability.recovery = 'openProvider';
        }
        if (
          ['approve', 'requestChanges', 'submitReview'].includes(action) &&
          value.state !== 'open'
        )
          capability.restrictions.push(value.state);
        if (
          ['merge', 'deleteBranch', 'updateBranch', 'enableAutoMerge', 'disableAutoMerge'].includes(
            action
          )
        ) {
          capability.permission = value.repo.viewerCanPush ? 'allowed' : 'forbidden';
          if (!value.repo.viewerCanPush) {
            capability.explanation = 'permission_required';
            capability.recovery = 'openProvider';
          }
          if (value.state !== 'open') capability.restrictions.push(value.state);
        }
        if (action === 'merge' || action === 'enableAutoMerge') {
          if (value.draft) capability.restrictions.push('draft');
          if (value.mergeable === false) capability.restrictions.push('conflict');
          if (value.mergeable === null) capability.restrictions.push('mergeability_unknown');
          if (
            action === 'merge' &&
            !['clean', 'unstable', 'has_hooks'].includes(value.mergeableState ?? '')
          )
            capability.restrictions.push(value.mergeableState ?? 'mergeability_unknown');
        }
        if (action === 'deleteBranch' && value.isCrossRepo)
          capability.restrictions.push('cross_repository_source');
        if (action === 'updateBranch' && !value.repo.allowUpdateBranch)
          capability.restrictions.push('branch_update_not_allowed');
        if (action === 'enableAutoMerge' && !value.repo.allowAutoMerge)
          capability.restrictions.push('auto_merge_not_allowed');
        if (action === 'disableAutoMerge' && !value.autoMerge)
          capability.restrictions.push('auto_merge_not_enabled');
        if (action === 'inlineComment') capability.expectedHeadProtection = 'revisionAttachment';
        if (action === 'merge') capability.expectedHeadProtection = 'atomicSource';
        return [action, capability];
      })
    )
  );
}

export function createGitHubReviewBridge(ctx: TRPCContext) {
  const caller = githubPrReviewRouter.createCaller(ctx);
  const call = <T>(work: Parameters<typeof withGitHubUserTokenRetry<T>>[0]['call']) =>
    withGitHubUserTokenRetry({ kiloUserId: ctx.user.id, call: work });

  async function credential() {
    const result = await getGitHubUserAccessToken(ctx.user.id, { op: 'fetch' });
    if (result.status !== 'connected') throw reconnect();
    return result.credential;
  }
  async function authorization(expected?: GitHubUserAuthorization) {
    if (expected && expected.accountId !== ctx.user.id) throw conflict();
    const first = await credential();
    if (expected && expected.authorizationId !== first.authorizationId) throw conflict();
    const user = z
      .object({
        id: z.number().int().positive(),
        login: z.string().min(1),
        name: z.string().nullish(),
        avatar_url: z.url().nullish(),
      })
      .parse(await call(async octokit => (await octokit.users.getAuthenticated()).data));
    if ((await credential()).authorizationId !== first.authorizationId) throw conflict();
    return {
      authorization: {
        kind: 'githubUser' as const,
        accountId: ctx.user.id,
        authorizationId: first.authorizationId,
      },
      actor: {
        provider: 'github' as const,
        instanceUrl: 'https://github.com',
        id: String(user.id),
        login: user.login,
        displayName: user.name ?? null,
        avatarUrl: z.url({ protocol: /^https$/ }).safeParse(user.avatar_url).success
          ? (user.avatar_url ?? null)
          : null,
      },
    };
  }
  async function getAuthorization() {
    const result = await getGitHubUserAccessToken(ctx.user.id, { op: 'fetch' });
    if (result.status === 'disconnected')
      return {
        status: 'not_connected' as const,
        reason: result.reason,
        authorization: null,
        actor: null,
      };
    if (result.status !== 'connected')
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'temporarily_unavailable' });
    return { status: 'connected' as const, reason: null, ...(await authorization()) };
  }
  async function metadata(input: Address, auth: Awaited<ReturnType<typeof authorization>>) {
    const value = await call(async octokit => {
      const repo = repositorySchema.parse((await octokit.repos.get(input)).data);
      const pull = pullSchema.parse(
        (await octokit.pulls.get({ ...input, pull_number: input.number })).data
      );
      return { repo, pull };
    });
    if (
      value.repo.full_name.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase() ||
      value.pull.number !== input.number ||
      value.pull.base.repo.id !== value.repo.id
    )
      throw conflict();
    const normalized = normalizeLegacyGitHubReviewRepository({
      accountId: ctx.user.id,
      repository: {
        fullName: value.repo.full_name,
        repositoryId: String(value.repo.id),
        defaultBranch: value.repo.default_branch,
      },
      authorization: auth.authorization,
    });
    if (normalized.kind !== 'resolved') throw conflict();
    return {
      ...value,
      identity: {
        ...normalized.reference,
        number: String(input.number),
        reviewId: value.pull.node_id,
        canonicalUrl: `https://github.com/${value.repo.full_name}/pull/${input.number}`,
      },
    };
  }
  async function getReview(
    input: Address,
    expected?: GitHubUserAuthorization
  ): Promise<ReviewOverview> {
    input = GitHubReviewAddressSchema.parse(input);
    const auth = await authorization(expected);
    const value = await caller.getPullRequest(input);
    const meta = await metadata(input, auth);
    if (value.headSha !== meta.pull.head.sha || value.prNodeId !== meta.identity.reviewId)
      throw conflict();
    // Old provider payloads can omit base/default metadata. Preserve explicit unavailable
    // values until old clients/records disappear and the 30-day ledger window expires.
    const baseSha = meta.pull.base.sha
      ? sha.parse(
          await call(
            async octokit =>
              (
                await octokit.repos.compareCommits({
                  ...input,
                  base: meta.pull.base.sha ?? '',
                  head: value.headSha,
                })
              ).data.merge_base_commit.sha
          )
        )
      : null;
    const source = meta.pull.head.repo;
    const checks = await getChecksFor(input, value.headSha);
    await authorization(auth.authorization);
    return {
      identity: meta.identity,
      title: value.title,
      bodyMarkdown: value.bodyMarkdown,
      author: author(value.author),
      state: value.state,
      draft: value.draft,
      revision: {
        headSha: value.headSha,
        baseSha,
        startSha: null,
        targetHeadSha: meta.pull.base.sha ?? null,
      },
      source: {
        repository: source
          ? {
              provider: 'github',
              instanceUrl: 'https://github.com',
              repositoryId: String(source.id),
              fullName: source.full_name,
              defaultBranch: source.default_branch ?? null,
            }
          : null,
        branch: value.headRef,
      },
      target: { repository: meta.identity.repository, branch: value.baseRef },
      authorization: {
        actor: auth.actor,
        credentialKind: 'githubUser',
        capabilities: capabilities(value),
        writeLimits: { requestMaxBytes: Number.MAX_SAFE_INTEGER, bodyMaxBytes: null },
      },
      providerState: { provider: 'github', decision: value.reviewDecision },
      checks,
      counts: {
        commits: value.counts.commits,
        files: value.counts.changedFiles,
        additions: value.counts.additions,
        deletions: value.counts.deletions,
      },
      merge: {
        methods: (['merge', 'squash', 'rebase'] as const)
          .filter(
            method =>
              ({
                merge: value.repo.allowMergeCommit,
                squash: value.repo.allowSquashMerge,
                rebase: value.repo.allowRebaseMerge,
              })[method]
          )
          .map(id => ({ id, label: id })),
        squash: null,
        autoMerge: value.autoMerge,
        task: null,
      },
    };
  }
  async function getChecksFor(input: Address, ref: string): Promise<ReviewOverview['checks']> {
    const raw = await fetchGitHubReviewChecks(ctx.user.id, {
      owner: input.owner,
      repo: input.repo,
      ref,
    });
    const { checkRuns } = buildChecksResult(raw);
    if (!checkRuns.length) return { status: 'none', checks: [] };
    // The mapper retains run order and one status per context in first-seen order.
    // A status context keeps its identity when a newer status replaces its value.
    const ids = [
      ...raw.checkRuns.map(
        check => `check-run:${z.number().int().positive().safe().parse(check.id)}`
      ),
      ...new Set(raw.commitStatuses.map(status => `status:${status.context}`)),
    ];
    return {
      status: 'reported',
      checks: checkRuns.map((check, index) => ({
        id: ids[index],
        name: check.name,
        required: null,
        detailsUrl: check.detailsUrl,
        state:
          check.status === 'queued' || check.status === 'pending'
            ? 'pending'
            : check.status === 'in_progress'
              ? 'running'
              : check.conclusion === 'success'
                ? 'passed'
                : check.conclusion === 'skipped' || check.conclusion === 'neutral'
                  ? 'skipped'
                  : check.conclusion === 'cancelled'
                    ? 'cancelled'
                    : [
                          'failure',
                          'error',
                          'timed_out',
                          'action_required',
                          'startup_failure',
                        ].includes(check.conclusion ?? '')
                      ? 'failed'
                      : 'unknown',
      })),
    };
  }
  function page(
    overview: ReviewOverview,
    surface: 'files' | 'threads',
    cursor?: ReviewCursor | null
  ) {
    const scope = {
      resourceKey: reviewResourceKey(ctx.user.id, overview.identity),
      surface,
      queryKey: 'all',
      revision: overview.revision,
    };
    return {
      token: cursor ? parseReviewCursor(cursor, scope).token : undefined,
      next: (token: string | null): ReviewCursor | null =>
        token === null ? null : { scopeKey: reviewPageKey(scope), token },
    };
  }
  async function unchanged(overview: ReviewOverview) {
    if (overview.identity.authorization.kind !== 'githubUser') throw conflict();
    const current = await getReview(address(overview), overview.identity.authorization);
    if (
      reviewResourceKey(ctx.user.id, current.identity) !==
      reviewResourceKey(ctx.user.id, overview.identity)
    )
      throw conflict();
    sameRevision(overview.revision, current.revision);
  }
  async function listInbox(cursor?: ReviewCursor | null): Promise<ReviewInbox> {
    const auth = await authorization();
    const scope = {
      resourceKey: JSON.stringify([ctx.user.id, auth.authorization, auth.actor.id]),
      surface: 'inbox' as const,
      queryKey: 'review-requested',
      revision: null,
    };
    const result = await caller.listInbox({
      cursor: cursor ? parseReviewCursor(cursor, scope).token : undefined,
    });
    const items = [];
    for (const item of result.items)
      items.push({
        identity: (await metadata(item, auth)).identity,
        title: item.title,
        author: author(item.author),
        state: 'open' as const,
        draft: item.isDraft,
        updatedAt: item.updatedAt,
      });
    await authorization(auth.authorization);
    return {
      items,
      nextCursor: result.nextCursor
        ? { scopeKey: reviewPageKey(scope), token: result.nextCursor }
        : null,
      scope: { kind: 'actor', actor: auth.actor },
    };
  }
  async function listFiles(
    overview: ReviewOverview,
    cursor?: ReviewCursor | null
  ): Promise<ReviewPage<ReviewFile>> {
    const paging = page(overview, 'files', cursor);
    const result = await caller.listFiles({
      ...address(overview),
      cursor: paging.token ? z.number().int().positive().parse(Number(paging.token)) : undefined,
    });
    await unchanged(overview);
    return {
      items: result.files.map(file => ({
        id: file.path,
        oldPath: file.status === 'added' ? null : (file.previousPath ?? file.path),
        newPath: file.status === 'removed' ? null : file.path,
        revision: overview.revision,
        status:
          file.status === 'removed'
            ? 'deleted'
            : file.status === 'added' || file.status === 'renamed' || file.status === 'copied'
              ? file.status
              : 'modified',
        patch: file.patch,
        content: file.patchMissing ? 'unavailable' : 'available',
        additions: file.additions,
        deletions: file.deletions,
        canonicalUrl: `${overview.identity.canonicalUrl}/files`,
      })),
      nextCursor: paging.next(result.nextCursor === null ? null : String(result.nextCursor)),
    };
  }
  async function getFileContext(
    overview: ReviewOverview,
    input: {
      file: Pick<ReviewFile, 'oldPath' | 'newPath' | 'revision'>;
      side: 'old' | 'new';
      startLine: number;
      lineCount: number;
    }
  ): Promise<ReviewFileContext> {
    sameRevision(input.file.revision, overview.revision);
    let cursor: ReviewCursor | null = null;
    let found = false;
    do {
      const files = await listFiles(overview, cursor);
      found = files.items.some(
        file => file.oldPath === input.file.oldPath && file.newPath === input.file.newPath
      );
      cursor = files.nextCursor;
    } while (!found && cursor);
    if (!found) throw conflict();
    const path = input.side === 'old' ? input.file.oldPath : input.file.newPath;
    const ref = input.side === 'old' ? overview.revision.baseSha : overview.revision.headSha;
    const repository =
      input.side === 'old' ? overview.target.repository : overview.source.repository;
    if (!path) throw new TRPCError({ code: 'BAD_REQUEST', message: 'file_side_unavailable' });
    const result: ReviewFileContext = {
      revision: input.file.revision,
      path,
      side: input.side,
      startLine: input.startLine,
      lines: [],
      totalLines: null,
      content: 'unavailable',
      canonicalUrl: overview.identity.canonicalUrl,
    };
    if (!ref || !repository) return result;
    result.canonicalUrl = `https://github.com/${repository.fullName}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const [owner, repo] = repository.fullName.split('/');
    try {
      const lines = await caller.getFileLines({
        owner,
        repo,
        path,
        ref,
        startLine: input.startLine,
        endLine: input.startLine + input.lineCount - 1,
      });
      await unchanged(overview);
      return lines.lines.some(line => line.includes('\0'))
        ? { ...result, content: 'binary' }
        : { ...result, ...lines, content: 'available' };
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'NOT_FOUND') return result;
      throw error;
    }
  }
  async function listDiscussions(
    overview: ReviewOverview,
    cursor?: ReviewCursor | null
  ): Promise<ReviewPage<ReviewThread>> {
    const paging = page(overview, 'threads', cursor);
    const result = await caller.listReviewThreads({ ...address(overview), cursor: paging.token });
    await unchanged(overview);
    const comment = (value: (typeof result.conversation)[number]) => ({
      id: String(value.commentId),
      reference: {
        provider: 'github' as const,
        kind: 'comment' as const,
        id: value.nodeId,
        url: `${overview.identity.canonicalUrl}#discussion_r${value.commentId}`,
      },
      author: author(value.author),
      bodyMarkdown: value.bodyMarkdown,
      createdAt: value.createdAt,
      reactions: value.reactions.map(reaction => ({ ...reaction, id: reaction.content })),
    });
    // Old threads omit immutable original revisions and rename paths. Do not attach them
    // to the current head; retain null positions until old payloads/records and the 30-day window expire.
    const threads: ReviewThread[] = result.threads.map(thread => ({
      id: thread.threadId,
      reference: {
        provider: 'github',
        kind: 'thread',
        id: thread.threadId,
        url: overview.identity.canonicalUrl,
      },
      subjectType: thread.subjectType === 'LINE' ? 'line' : 'file',
      file: null,
      position: null,
      diffHunk: thread.diffHunk,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      comments: { items: thread.comments.map(comment), nextCursor: null },
      capabilities: overview.authorization.capabilities,
    }));
    threads.push(
      ...result.conversation.map(value => ({
        id: value.nodeId,
        reference: {
          provider: 'github' as const,
          kind: 'comment' as const,
          id: value.nodeId,
          url: `${overview.identity.canonicalUrl}#issuecomment-${value.commentId}`,
        },
        subjectType: 'conversation' as const,
        file: null,
        position: null,
        diffHunk: null,
        resolved: null,
        outdated: null,
        comments: { items: [comment(value)], nextCursor: null },
        capabilities: {},
      }))
    );
    return { items: threads, nextCursor: paging.next(result.nextCursor) };
  }

  async function runOperation(
    overview: ReviewOverview,
    intent: ReviewIntent,
    operationKey: string,
    statusOnly = false
  ): Promise<ReviewMutationResult> {
    if (
      intent.accountId !== ctx.user.id ||
      intent.actorId !== overview.authorization.actor.id ||
      reviewResourceKey(ctx.user.id, intent.review) !==
        reviewResourceKey(ctx.user.id, overview.identity)
    )
      throw conflict();
    const input = intent.input;
    const fields: Partial<Record<ReviewIntent['input']['action'], string[]>> = {
      comment: ['body'],
      inlineComment: ['body', 'position'],
      reply: ['body', 'target'],
      submitReview: ['body', 'choice', 'comments'],
      approve: ['body'],
      requestChanges: ['body'],
      merge: ['method', 'commitTitle', 'commitMessage', 'deletion'],
      resolveThread: ['target'],
      reopenThread: ['target'],
      addReaction: ['target', 'reaction'],
      removeReaction: ['target', 'reaction'],
      updateBranch: [],
      enableAutoMerge: ['method', 'commitTitle', 'commitMessage'],
      disableAutoMerge: [],
    };
    const allowed = fields[input.action];
    if (!allowed || Object.keys(input).some(key => key !== 'action' && !allowed.includes(key)))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_action_fields' });
    function freshWrite() {
      sameRevision(intent.revision, overview.revision);
      const capability = overview.authorization.capabilities[input.action];
      if (reviewActionAvailability(capability) !== 'available')
        throw new TRPCError({
          code: capability.permission === 'forbidden' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
          message: capability.explanation || capability.restrictions[0] || 'action_not_available',
        });
      if (
        ['merge', 'enableAutoMerge'].includes(input.action) &&
        !overview.merge.methods.some(
          method => method.id === (input.method ?? 'merge').toLowerCase()
        )
      )
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'merge_method_not_available' });
    }
    async function authorizeWrite() {
      if (overview.identity.authorization.kind !== 'githubUser') throw conflict();
      const current = await authorization(overview.identity.authorization);
      if (current.actor.id !== intent.actorId) throw conflict();
    }
    const common = { ...address(overview), operationKey };
    const reference = {
      provider: 'github' as const,
      kind: 'review' as const,
      id: overview.identity.reviewId,
      url: overview.identity.canonicalUrl,
    };
    const confirmed = (ref = reference): ReviewMutationResult => ({
      status: 'confirmed',
      reference: ref,
      retry: 'never',
      reconciliation: 'complete',
    });
    const unresolved = (reason: string): ReviewMutationResult => ({
      status: 'unresolved',
      reason,
      reference,
      retry: 'reconcile',
      reconciliation: 'required',
    });
    const position = (value?: ReviewPosition) => {
      if (!value || value.native.provider !== 'github')
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid_position' });
      sameRevision(value.revision, intent.revision);
      return CommentPositionSchema.parse({
        path: value.newPath ?? value.oldPath,
        line: value.line,
        side: value.side === 'old' ? 'LEFT' : 'RIGHT',
        startLine: value.startLine,
        startSide:
          value.startSide === undefined ? undefined : value.startSide === 'old' ? 'LEFT' : 'RIGHT',
      });
    };
    async function ledger(
      intentName: PrLedgerIntent,
      legacy: Record<string, unknown>,
      execute: () => Promise<unknown>
    ) {
      const [row] = await db
        .select()
        .from(operation_ledgers)
        .where(
          and(
            eq(operation_ledgers.kilo_user_id, ctx.user.id),
            eq(operation_ledgers.domain, 'pr'),
            eq(operation_ledgers.operation_key, operationKey)
          )
        )
        .limit(1);
      // Old ledger addresses retain caller casing, unlike canonical repository metadata.
      // Keep those bytes until old clients/records and the 30-day ledger window expire.
      const savedAddress = row?.resource_key?.match(
        /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)::[a-f0-9]{16}$/
      );
      if (
        savedAddress &&
        `${savedAddress[1]}/${savedAddress[2]}`.toLowerCase() ===
          overview.identity.repository.fullName.toLowerCase() &&
        savedAddress[3] === overview.identity.number
      ) {
        legacy.owner = savedAddress[1];
        legacy.repo = savedAddress[2];
      }
      if (
        row &&
        (row.intent !== intentName || row.resource_key !== prLedgerResourceKey(intentName, legacy))
      )
        throw new TRPCError({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
      // Unsettled merge retries share read-only recovery. Legacy reconciliation can
      // settle a different merged head or dispatch another write under this key.
      if (row && intentName === 'merge' && !['completed', 'no_op', 'failed'].includes(row.status))
        return overview.state === 'merged' && overview.revision.headSha === intent.revision.headSha
          ? normalizeResult({ merged: true, branchDeleted: false })
          : unresolved('merge_not_confirmed');
      if (statusOnly) {
        if (!row)
          return {
            status: 'rejected' as const,
            code: 'operation_not_admitted',
            explanation: 'operation_not_admitted',
            retry: 'same-key' as const,
            reconciliation: 'not-needed' as const,
          };
        if (row.status === 'completed' || row.status === 'no_op')
          return normalizeResult(row.canonical_result);
        if (row.status === 'failed')
          return {
            status: 'rejected' as const,
            code: 'operation_failed',
            explanation: 'operation_failed',
            retry: 'never' as const,
            reconciliation: 'not-needed' as const,
          };
        const referenceKey = intentName === 'submit_review' ? 'reviewId' : 'commentId';
        const providerId = z
          .number()
          .int()
          .positive()
          .safeParse(row.canonical_result?.[referenceKey]);
        if (!providerId.success) return unresolved('provider_receipt_unavailable');
        try {
          const actualId = await call(async octokit => {
            const response =
              intentName === 'submit_review'
                ? await octokit.pulls.getReview({
                    ...address(overview),
                    pull_number: common.number,
                    review_id: providerId.data,
                  })
                : await octokit.pulls.getReviewComment({
                    owner: common.owner,
                    repo: common.repo,
                    comment_id: providerId.data,
                  });
            return response.data.id;
          });
          return actualId === providerId.data
            ? normalizeResult(row.canonical_result)
            : unresolved('provider_receipt_unavailable');
        } catch (error) {
          if (error instanceof TRPCError && ['NOT_FOUND', 'BAD_GATEWAY'].includes(error.code))
            return unresolved('provider_receipt_unavailable');
          throw error;
        }
      }
      if (!row) freshWrite();
      await authorizeWrite();
      return normalizeResult(await execute());
    }
    function normalizeResult(raw: unknown): ReviewMutationResult {
      const parsed = z
        .object({
          commentId: z.number().int().positive().optional(),
          reviewId: z.number().int().positive().optional(),
          state: z.string().optional(),
          merged: z.boolean().optional(),
          branchDeleted: z.boolean().optional(),
        })
        .safeParse(raw);
      // Old ledger results can lack receipt fields. Keep them unresolved until old
      // clients/records disappear and the 30-day ledger window expires.
      if (!parsed.success) return unresolved('provider_receipt_unavailable');
      const result = parsed.data;
      if (input.action === 'merge' && result.merged !== true)
        return unresolved('merge_not_confirmed');
      if (
        input.action !== 'merge' &&
        (['inlineComment', 'reply'].includes(input.action) ? !result.commentId : !result.reviewId)
      )
        return unresolved('provider_receipt_unavailable');
      if (!['merge', 'inlineComment', 'reply'].includes(input.action)) {
        const choice = input.action === 'submitReview' ? input.choice : input.action;
        const expectedState =
          choice === 'approve'
            ? 'APPROVED'
            : choice === 'requestChanges'
              ? 'CHANGES_REQUESTED'
              : 'COMMENTED';
        if (result.state !== expectedState) return unresolved('review_state_unconfirmed');
      }
      if (result.merged && input.deletion?.effect === 'delete' && result.branchDeleted !== true)
        return {
          status: 'partial',
          items: [
            {
              itemId: 'merge',
              effect: 'merge',
              result: {
                status: 'confirmed',
                reference,
                retry: 'never',
                reconciliation: 'complete',
              },
            },
            {
              itemId: 'deleteBranch',
              effect: 'deleteBranch',
              result: {
                status: 'unresolved',
                reference,
                reason: 'branch_deletion_unconfirmed',
                retry: 'reconcile',
                reconciliation: 'required',
              },
            },
          ],
          retry: 'unfinished-only',
          reconciliation: 'required',
        };
      return {
        status: 'confirmed',
        reference: result.commentId
          ? { ...reference, kind: 'comment', id: String(result.commentId) }
          : result.reviewId
            ? { ...reference, id: String(result.reviewId) }
            : reference,
        retry: 'never',
        reconciliation: 'complete',
      };
    }
    if (input.action === 'inlineComment') {
      const legacy = {
        ...common,
        ...position(input.position),
        body: z.string().min(1).parse(input.body),
        commitSha: intent.revision.headSha,
      };
      return ledger('create_review_comment', legacy, () => caller.createReviewComment(legacy));
    }
    if (['comment', 'submitReview', 'approve', 'requestChanges'].includes(input.action)) {
      const choice = input.action === 'submitReview' ? input.choice : input.action;
      const legacy = {
        ...common,
        event:
          choice === 'approve'
            ? ('APPROVE' as const)
            : choice === 'requestChanges'
              ? ('REQUEST_CHANGES' as const)
              : ('COMMENT' as const),
        body: input.body,
        commitSha: intent.revision.headSha,
        comments: input.comments?.map(value => ({ ...position(value.position), body: value.body })),
      };
      return ledger('submit_review', legacy, () => caller.submitReview(legacy));
    }
    if (input.action === 'merge') {
      if (
        input.deletion &&
        (input.deletion.repositoryKey !== repositoryResourceKey(ctx.user.id, overview.identity) ||
          input.deletion.branch !== overview.source.branch ||
          input.deletion.expectedHeadSha !== intent.revision.headSha)
      )
        throw conflict();
      const legacy = {
        ...common,
        method: MergeMethodSchema.parse(input.method),
        commitTitle: input.commitTitle,
        commitMessage: input.commitMessage,
        deleteBranch: input.deletion?.effect === 'delete',
        expectedHeadSha: intent.revision.headSha,
      };
      return ledger('merge', legacy, () => caller.mergePullRequest(legacy));
    }
    let targetThread: ReviewThread | undefined;
    let targetComment: ReviewThread['comments']['items'][number] | undefined;
    if (input.target) {
      if (input.target.provider !== 'github') throw conflict();
      let cursor: ReviewCursor | null = null;
      do {
        const discussions = await listDiscussions(overview, cursor);
        targetThread = discussions.items.find(
          thread =>
            thread.reference.kind === input.target?.kind && thread.reference.id === input.target.id
        );
        targetComment = discussions.items
          .flatMap(thread => thread.comments.items)
          .find(comment => comment.reference.id === input.target?.id);
        cursor = discussions.nextCursor;
      } while (!targetThread && !targetComment && cursor);
      if (!targetThread && !targetComment)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'discussion_target_not_found' });
    }
    if (input.action === 'reply') {
      if (!targetComment) throw new TRPCError({ code: 'BAD_REQUEST', message: 'comment_required' });
      const legacy = {
        ...common,
        body: z.string().min(1).parse(input.body),
        commentId: Number(targetComment.id),
      };
      return ledger('reply_comment', legacy, () => caller.replyToComment(legacy));
    }
    if (statusOnly) {
      switch (input.action) {
        case 'resolveThread':
        case 'reopenThread':
          if (!targetThread || targetThread.reference.kind !== 'thread') throw conflict();
          return targetThread.resolved === (input.action === 'resolveThread')
            ? confirmed()
            : unresolved('thread_state_unconfirmed');
        case 'addReaction':
        case 'removeReaction': {
          if (!targetComment) throw conflict();
          const content = ReactionContentSchema.parse(input.reaction);
          const reacted = targetComment.reactions.some(
            reaction => reaction.content === content && reaction.viewerHasReacted
          );
          return reacted === (input.action === 'addReaction')
            ? confirmed()
            : unresolved('reaction_state_unconfirmed');
        }
        case 'enableAutoMerge':
          return overview.merge.autoMerge?.method.toUpperCase() ===
            AutoMergeMethodSchema.parse(input.method?.toUpperCase() ?? 'MERGE')
            ? confirmed()
            : unresolved('auto_merge_state_unconfirmed');
        case 'disableAutoMerge':
          return overview.state === 'open' && overview.merge.autoMerge === null
            ? confirmed()
            : unresolved('auto_merge_state_unconfirmed');
        case 'updateBranch': {
          const source = overview.source.repository;
          const ancestors = [intent.revision.headSha, intent.revision.targetHeadSha];
          // Old revisions can omit the target head. Do not infer an update from a changed head.
          // Keep this fallback until old clients/records and the 30-day ledger window expire.
          if (!source || ancestors.some(value => !sha.safeParse(value).success))
            return unresolved('branch_update_unconfirmed');
          const [owner, repo] = source.fullName.split('/');
          try {
            for (const ancestor of ancestors) {
              const base = sha.parse(ancestor);
              const mergeBase = await call(
                async octokit =>
                  (
                    await octokit.repos.compareCommits({
                      owner,
                      repo,
                      base,
                      head: overview.revision.headSha,
                    })
                  ).data.merge_base_commit.sha
              );
              if (mergeBase !== base) return unresolved('branch_update_unconfirmed');
            }
            await unchanged(overview);
            return confirmed();
          } catch (error) {
            if (error instanceof TRPCError && ['NOT_FOUND', 'BAD_GATEWAY'].includes(error.code))
              return unresolved('branch_update_unconfirmed');
            throw error;
          }
        }
        default:
          return unresolved('provider_outcome_unknown');
      }
    }
    freshWrite();
    await authorizeWrite();
    switch (input.action) {
      case 'resolveThread':
      case 'reopenThread': {
        if (!targetThread || targetThread.reference.kind !== 'thread') throw conflict();
        const result =
          input.action === 'resolveThread'
            ? await caller.resolveThread({ threadId: targetThread.id })
            : await caller.unresolveThread({ threadId: targetThread.id });
        return result.threadId === targetThread.id &&
          result.isResolved === (input.action === 'resolveThread')
          ? confirmed()
          : unresolved('thread_state_unconfirmed');
      }
      case 'addReaction':
      case 'removeReaction': {
        if (!targetComment) throw conflict();
        const legacy = {
          commentNodeId: targetComment.reference.id,
          content: ReactionContentSchema.parse(input.reaction),
        };
        const result =
          input.action === 'addReaction'
            ? await caller.addReaction(legacy)
            : await caller.removeReaction(legacy);
        return result.content === legacy.content
          ? confirmed()
          : unresolved('reaction_state_unconfirmed');
      }
      case 'updateBranch':
        await caller.updateBranch({
          ...address(overview),
          expectedHeadSha: intent.revision.headSha,
        });
        return {
          status: 'accepted',
          reference,
          task: null,
          retry: 'reconcile',
          reconciliation: 'pending',
        };
      case 'enableAutoMerge': {
        const result = await caller.enableAutoMerge({
          ...address(overview),
          prNodeId: overview.identity.reviewId,
          method: AutoMergeMethodSchema.parse(input.method?.toUpperCase() ?? 'MERGE'),
          commitTitle: input.commitTitle,
          commitMessage: input.commitMessage,
        });
        return result.prNodeId === overview.identity.reviewId
          ? confirmed()
          : unresolved('auto_merge_state_unconfirmed');
      }
      case 'disableAutoMerge': {
        const result = await caller.disableAutoMerge({
          ...address(overview),
          prNodeId: overview.identity.reviewId,
        });
        return result.prNodeId === overview.identity.reviewId
          ? confirmed()
          : unresolved('auto_merge_state_unconfirmed');
      }
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'action_not_available' });
    }
  }
  return {
    getAuthorization,
    getReview,
    listInbox,
    listFiles,
    getFileContext,
    listDiscussions,
    runOperation(
      overview: ReviewOverview,
      intent: ReviewIntent,
      operationKey: string,
      statusOnly = false
    ) {
      const authorization = overview.identity.authorization;
      if (authorization.kind !== 'githubUser') throw conflict();
      return withGitHubReviewIdentity(
        {
          accountId: authorization.accountId,
          authorizationId: authorization.authorizationId,
          actorId: intent.actorId,
        },
        () => runOperation(overview, intent, operationKey, statusOnly)
      );
    },
  };
}
