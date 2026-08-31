import 'server-only';

import { z } from 'zod';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import {
  ReviewIntentInputSchema,
  ReviewPositionSchema,
  ReviewRevisionSchema,
  reviewResourceKey,
  serializeReviewWriteRequest,
  type ProviderReference,
  type ReviewIntentInput,
  type ReviewMutationResult,
  type ReviewPosition,
  type ReviewRevision,
} from '@kilocode/app-shared/provider-review';
import { GitLabInteractiveError } from '@/lib/integrations/platforms/gitlab/interactive-client';
import {
  GitLabPathSchema,
  GitLabUserSchema,
  parseGitLab,
  resolveGitLabReviewProject,
  type GitLabReviewAuthorization,
} from './gitlab-authorization';
import { getGitLabReview, listGitLabFiles } from './gitlab-read';
import {
  confirmedReviewEffect,
  rejectedReviewEffect,
  unresolvedReviewEffect,
  runReviewOperation,
  type ReviewEffectResult,
  type ReviewOperationRequest,
} from './operation';

const id = z.number().int().positive().safe();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const refs = z.object({ head_sha: sha, base_sha: sha, start_sha: sha });
const positionSchema = refs.extend({
  position_type: z.literal('text'),
  old_path: z.string(),
  new_path: z.string(),
  old_line: id.nullish(),
  new_line: id.nullish(),
  line_range: z
    .object({
      start: z.object({
        line_code: z.string(),
        type: z.enum(['old', 'new']),
        old_line: id.nullish(),
        new_line: id.nullish(),
      }),
      end: z.object({
        line_code: z.string(),
        type: z.enum(['old', 'new']),
        old_line: id.nullish(),
        new_line: id.nullish(),
      }),
    })
    .nullish(),
});
const noteSchema = z.object({
  id,
  body: z.string(),
  author: GitLabUserSchema.nullish(),
  noteable_id: id,
  // Existing image/file discussions remain replyable. Validate positions only for inline receipts.
  position: z.unknown().optional(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  current_user: z.object({ can_resolve: z.boolean() }).optional(),
});
const threadSchema = z.object({ id: z.string().min(1), notes: z.array(noteSchema).min(1) });
const awardSchema = z.object({ id, name: z.string(), user: GitLabUserSchema });
const branchSchema = z.object({
  name: z.string(),
  default: z.boolean(),
  protected: z.boolean(),
  can_push: z.boolean(),
  commit: z.object({ id: sha }),
});
const reviewSchema = z.object({
  id,
  iid: id,
  project_id: id,
  target_project_id: id,
  source_project_id: id.nullable(),
  web_url: z.url(),
  state: z.string(),
  sha,
  diff_refs: refs.nullish(),
  source_branch: z.string().nullable(),
  target_branch: z.string(),
  user: z.object({ can_merge: z.boolean().optional() }).nullish(),
  merge_when_pipeline_succeeds: z.boolean().optional(),
  auto_merge_enabled: z.boolean().optional(),
  rebase_in_progress: z.boolean().optional(),
  merge_error: z.string().nullable().optional(),
});
type Context = { auth: GitLabReviewAuthorization; request: ReviewOperationRequest };
type Effect = { itemId: string; input: ReviewIntentInput; draft?: ProviderReference };

function sameRevision(expected: ReviewRevision, actual: ReviewRevision): void {
  if (
    JSON.stringify(ReviewRevisionSchema.parse(expected)) !==
    JSON.stringify(ReviewRevisionSchema.parse(actual))
  )
    throw new GitLabInteractiveError('conflict');
}
function numeric(value: string): number {
  return parseGitLab(
    id,
    Number(parseGitLab(z.string().regex(/^[1-9]\d*$/), value, 'invalid_request')),
    'invalid_request'
  );
}
function reference(
  context: Context,
  kind: ProviderReference['kind'],
  value: string
): ProviderReference {
  return { provider: 'gitlab', kind, id: value, url: context.request.intent.review.canonicalUrl };
}
function pending(reference: ProviderReference): ReviewEffectResult {
  return {
    status: 'accepted',
    reference,
    task: null,
    retry: 'reconcile',
    reconciliation: 'pending',
  };
}
function target(
  context: Context,
  input: ReviewIntentInput,
  kind: ProviderReference['kind']
): string {
  const value = input.target;
  if (
    !value ||
    value.provider !== 'gitlab' ||
    value.kind !== kind ||
    (value.url !== null && value.url.split('#')[0] !== context.request.intent.review.canonicalUrl)
  )
    throw new GitLabInteractiveError('invalid_request');
  return parseGitLab(z.string().min(1).max(512), value.id, 'invalid_request');
}
function gitLabPosition(position: ReviewPosition, revision: ReviewRevision) {
  const value = parseGitLab(ReviewPositionSchema, position, 'invalid_request');
  sameRevision(revision, value.revision);
  if (
    value.native.provider !== 'gitlab' ||
    !value.revision.baseSha ||
    !value.revision.startSha ||
    !value.oldPath ||
    !value.newPath
  )
    throw new GitLabInteractiveError('invalid_request');
  const { native } = value;
  const end = native.lineRange?.end;
  if (
    (end
      ? end.side !== value.side || (end.side === 'old' ? end.oldLine : end.newLine) !== value.line
      : (value.side === 'old' ? native.oldLine : native.newLine) !== value.line) ||
    (value.startLine === undefined) !== (native.lineRange === undefined) ||
    ((value.side === 'old' ? native.oldLine : native.newLine) !== null &&
      (value.side === 'old' ? native.oldLine : native.newLine) !== value.line) ||
    (value.startSide === value.side &&
      value.startLine !== undefined &&
      value.startLine > value.line) ||
    (native.lineRange &&
      (native.lineRange.start.side !== value.startSide ||
        (value.startSide === 'old'
          ? native.lineRange.start.oldLine
          : native.lineRange.start.newLine) !== value.startLine))
  )
    throw new GitLabInteractiveError('invalid_request');
  const rangeEnd = (part: NonNullable<typeof native.lineRange>['start']) => ({
    lineCode: part.lineCode,
    type: part.side,
    ...(part.oldLine === null ? {} : { oldLine: part.oldLine }),
    ...(part.newLine === null ? {} : { newLine: part.newLine }),
  });
  return {
    positionType: 'text' as const,
    baseSha: value.revision.baseSha,
    headSha: value.revision.headSha,
    startSha: value.revision.startSha,
    oldPath: parseGitLab(GitLabPathSchema, value.oldPath, 'invalid_request'),
    newPath: parseGitLab(GitLabPathSchema, value.newPath, 'invalid_request'),
    ...(native.oldLine === null ? {} : { oldLine: String(native.oldLine) }),
    ...(native.newLine === null ? {} : { newLine: String(native.newLine) }),
    ...(native.lineRange
      ? {
          lineRange: {
            start: rangeEnd(native.lineRange.start),
            end: rangeEnd(native.lineRange.end),
          },
        }
      : {}),
  };
}
function matchesPosition(value: unknown, expected: ReviewPosition): boolean {
  const parsed = positionSchema.safeParse(value);
  if (!parsed.success) return false;
  const actual = parsed.data;
  const position = gitLabPosition(expected, expected.revision);
  return (
    !!actual &&
    actual.head_sha === position.headSha &&
    actual.base_sha === position.baseSha &&
    actual.start_sha === position.startSha &&
    actual.old_path === position.oldPath &&
    actual.new_path === position.newPath &&
    (actual.old_line ?? null) ===
      (position.oldLine === undefined ? null : Number(position.oldLine)) &&
    (actual.new_line ?? null) ===
      (position.newLine === undefined ? null : Number(position.newLine)) &&
    (!position.lineRange
      ? !actual.line_range
      : ['start', 'end'].every(part => {
          const key = part === 'start' ? 'start' : 'end';
          const received = actual.line_range?.[key],
            selected = position.lineRange?.[key];
          return (
            received &&
            selected &&
            received.line_code === selected.lineCode &&
            received.type === selected.type &&
            (received.old_line ?? null) === (selected.oldLine ?? null) &&
            (received.new_line ?? null) === (selected.newLine ?? null)
          );
        }))
  );
}
async function snapshot(context: Context) {
  const {
    auth,
    request: { intent },
  } = context;
  const project = await resolveGitLabReviewProject(
    auth,
    intent.review.repository.repositoryId,
    intent.review.repository
  );
  const iid = numeric(intent.review.number);
  const review = parseGitLab(
    reviewSchema,
    (
      await project.client.execute(api =>
        api.MergeRequests.show(project.repository.repositoryId, iid, {
          includeRebaseInProgress: true,
        })
      )
    ).data
  );
  if (
    String(review.id) !== intent.review.reviewId ||
    review.iid !== iid ||
    String(review.project_id) !== project.repository.repositoryId ||
    review.target_project_id !== review.project_id ||
    new URL(review.web_url).toString() !== `${project.canonicalUrl}/-/merge_requests/${iid}` ||
    new URL(review.web_url).toString() !== intent.review.canonicalUrl
  )
    throw new GitLabInteractiveError('forbidden');
  if (review.diff_refs && review.sha !== review.diff_refs.head_sha)
    throw new GitLabInteractiveError('temporarily_unavailable');
  return {
    ...project,
    iid,
    review,
    revision: {
      headSha: review.sha,
      baseSha: review.diff_refs?.base_sha ?? null,
      startSha: review.diff_refs?.start_sha ?? null,
      targetHeadSha: null,
    },
  };
}
async function preflight(context: Context, effect: Effect) {
  const {
    auth,
    request: { intent },
  } = context;
  const { input } = effect;
  const overview = await getGitLabReview(auth, intent.review.repository, intent.review.number);
  if (
    reviewResourceKey(auth.userId, overview.identity) !==
      reviewResourceKey(auth.userId, intent.review) ||
    overview.identity.canonicalUrl !== intent.review.canonicalUrl
  )
    throw new GitLabInteractiveError('forbidden');
  sameRevision(intent.revision, overview.revision);
  const capability = overview.authorization.capabilities[input.action];
  if (
    (auth.scopes !== null && !auth.scopes.includes('api')) ||
    capability.permission === 'forbidden'
  )
    throw new GitLabInteractiveError('forbidden');
  if (
    capability.support === 'unsupported' ||
    capability.version === 'unavailable' ||
    capability.license === 'unavailable' ||
    capability.restrictions.length
  )
    throw new GitLabInteractiveError('conflict');
  const loaded = await snapshot(context);
  if (input.action === 'merge' || input.action === 'enableAutoMerge') {
    // Project-token scopes are not cached. Require the live actor permission; the API enforces token grants.
    if (
      capability.permission !== 'allowed' &&
      !(auth.scopes === null && loaded.review.user?.can_merge === true)
    )
      throw new GitLabInteractiveError('forbidden');
    if (
      !overview.merge.methods.some(method => method.id === input.method) ||
      loaded.project.merge_method !== input.method ||
      !loaded.project.squash_option ||
      (loaded.project.squash_option === 'always' && input.squash === false) ||
      (loaded.project.squash_option === 'never' && input.squash === true)
    )
      throw new GitLabInteractiveError('conflict');
  }
  if (input.position) {
    gitLabPosition(input.position, intent.revision);
    let cursor;
    let found = false;
    do {
      const page = await listGitLabFiles(auth, intent.review, intent.revision, cursor);
      found = page.items.some(
        file => file.oldPath === input.position?.oldPath && file.newPath === input.position.newPath
      );
      cursor = page.nextCursor;
    } while (!found && cursor);
    if (!found) throw new GitLabInteractiveError('conflict');
  }
  if (
    input.action === 'resolveThread' ||
    input.action === 'reopenThread' ||
    input.action === 'reply'
  ) {
    const threadId = target(context, input, 'thread');
    const thread = parseGitLab(
      threadSchema,
      (
        await loaded.client.execute(api =>
          api.MergeRequestDiscussions.show(loaded.repository.repositoryId, loaded.iid, threadId)
        )
      ).data
    );
    if (
      thread.id !== threadId ||
      thread.notes.some(note => String(note.noteable_id) !== intent.review.reviewId)
    )
      throw new GitLabInteractiveError('forbidden');
    if (input.action !== 'reply') {
      const access = Math.max(
        loaded.project.permissions?.project_access?.access_level ?? 0,
        loaded.project.permissions?.group_access?.access_level ?? 0
      );
      const resolvable = thread.notes.filter(note => note.resolvable);
      if (
        !resolvable.length ||
        resolvable.some(
          note =>
            !(
              note.current_user?.can_resolve ??
              (overview.author?.id === auth.actor.id || access >= 30)
            )
        )
      )
        throw new GitLabInteractiveError('forbidden');
    }
  }
  const deleting = input.deletion?.effect === 'delete';
  if (input.action === 'updateBranch' || input.action === 'deleteBranch' || deleting) {
    const sourceBranch = overview.source.branch;
    if (
      !overview.source.repository ||
      !sourceBranch ||
      (overview.source.repository.repositoryId === overview.target.repository.repositoryId &&
        sourceBranch === overview.target.branch)
    )
      throw new GitLabInteractiveError('forbidden');
    const source = await resolveGitLabReviewProject(
      auth,
      overview.source.repository.repositoryId,
      overview.source.repository
    );
    if (input.action === 'deleteBranch' || deleting) {
      const deletion = input.deletion;
      if (
        !deletion ||
        deletion.effect !== 'delete' ||
        deletion.branch !== sourceBranch ||
        deletion.expectedHeadSha !== intent.revision.headSha ||
        deletion.repositoryKey !==
          repositoryResourceKey(auth.userId, {
            repository: source.repository,
            authorization: auth.authorization,
          })
      )
        throw new GitLabInteractiveError('forbidden');
    }
    if (input.action === 'deleteBranch' ? overview.state !== 'merged' : overview.state !== 'open')
      throw new GitLabInteractiveError('conflict');
    const branch = parseGitLab(
      branchSchema,
      (
        await source.client.execute(api =>
          api.Branches.show(source.repository.repositoryId, sourceBranch)
        )
      ).data
    );
    if (branch.name !== sourceBranch || branch.commit.id !== intent.revision.headSha)
      throw new GitLabInteractiveError('conflict');
    if (!branch.can_push || (deleting && (branch.default || branch.protected)))
      throw new GitLabInteractiveError('forbidden');
    return { ...loaded, source, sourceBranch };
  }
  return { ...loaded, source: null, sourceBranch: null };
}
function errorResult(error: unknown, dispatched: boolean): ReviewEffectResult {
  if (error instanceof GitLabInteractiveError) {
    // Only explicit provider 4xx rejections prove that a dispatched write did not commit.
    if (
      !dispatched ||
      // These broker/request-budget errors occur before provider dispatch, including after preflight.
      ['forbidden', 'not_connected', 'reconnect_required', 'request_too_large'].includes(
        error.code
      ) ||
      (error.status !== undefined &&
        [400, 401, 403, 404, 405, 406, 409, 422, 429].includes(error.status))
    )
      return rejectedReviewEffect(
        error.code,
        ['temporarily_unavailable', 'pagination_limit', 'response_too_large'].includes(error.code)
          ? 'same-key'
          : 'never'
      );
  }
  return dispatched
    ? unresolvedReviewEffect('provider_outcome_unknown')
    : rejectedReviewEffect('preflight_unavailable', 'same-key');
}
async function perform(context: Context, effect: Effect): Promise<ReviewEffectResult> {
  const {
    auth,
    request: { intent },
  } = context;
  const { input } = effect;
  let dispatched = false;
  let result: ReviewEffectResult | undefined;
  try {
    const loaded = await preflight(context, effect);
    const { iid } = loaded;
    let providerStatus: number | undefined;
    async function receive<T extends { status: number }>(request: Promise<T>): Promise<T> {
      const response = await request;
      providerStatus = response.status;
      return response;
    }
    const client: Pick<typeof loaded.client, 'execute' | 'requestChanges'> = {
      execute: operation => receive(loaded.client.execute(operation)),
      requestChanges: number => receive(loaded.client.requestChanges(number)),
    };
    const completed = (ref: ProviderReference): ReviewEffectResult =>
      providerStatus === 202
        ? pending(ref)
        : providerStatus === undefined
          ? unresolvedReviewEffect('receipt_missing', ref)
          : confirmedReviewEffect(ref);
    const projectId = loaded.repository.repositoryId;
    let version: string | undefined;
    if (input.action === 'enableAutoMerge')
      version = parseGitLab(
        z.object({ version: z.string().regex(/^\d+\.\d+\./) }),
        (await client.execute(api => api.Metadata.show())).data
      ).version;
    if (effect.draft) {
      const draft = parseGitLab(
        z.object({
          id,
          author_id: id,
          merge_request_id: id,
          discussion_id: z.string().nullable(),
          resolve_discussion: z.boolean(),
          note: z.string(),
          position: positionSchema,
        }),
        (
          await client.execute(api =>
            api.MergeRequestDraftNotes.show(projectId, iid, numeric(effect.draft?.id ?? ''))
          )
        ).data
      );
      if (
        String(draft.id) !== effect.draft.id ||
        String(draft.author_id) !== auth.actor.id ||
        String(draft.merge_request_id) !== intent.review.reviewId ||
        // Native draft replies also resolve or reopen their stored discussion.
        draft.discussion_id !== null ||
        draft.resolve_discussion ||
        draft.note !== input.body ||
        !input.position ||
        !matchesPosition(draft.position, input.position)
      )
        throw new GitLabInteractiveError('conflict');
    }
    if (input.action === 'removeReaction') {
      const noteId = target(context, input, 'comment');
      const awards = await client.execute(api =>
        api.MergeRequestNoteAwardEmojis.all(projectId, iid, numeric(noteId), {
          perPage: 100,
          maxPages: 100,
        })
      );
      if (awards.headers['x-next-page'] || /rel="next"/.test(awards.headers.link ?? ''))
        throw new GitLabInteractiveError('pagination_limit');
      const award = parseGitLab(z.array(awardSchema), awards.data).find(
        item => String(item.id) === input.reaction
      );
      if (!award || String(award.user.id) !== auth.actor.id)
        throw new GitLabInteractiveError('forbidden');
    }
    // GitLab fences only source SHA for approval/merge. Inline positions attach to immutable refs.
    // Rebase and deletion have preflight-only protection; neither API accepts an expected SHA.
    const beforeDispatch = await snapshot(context);
    sameRevision(intent.revision, beforeDispatch.revision);
    if (
      (input.action === 'merge' || input.action === 'enableAutoMerge') &&
      (beforeDispatch.project.merge_method !== input.method ||
        beforeDispatch.project.squash_option !== loaded.project.squash_option)
    )
      throw new GitLabInteractiveError('conflict');
    dispatched = true;
    if (effect.draft) {
      await client.execute(api =>
        api.MergeRequestDraftNotes.publish(projectId, iid, numeric(effect.draft?.id ?? ''))
      );
      return completed(reference(context, 'comment', `draft:${effect.draft.id}`));
    }
    switch (input.action) {
      case 'comment':
      case 'inlineComment':
      case 'reply': {
        const response =
          input.action === 'inlineComment' && input.position
            ? await client.execute(api =>
                api.MergeRequestDiscussions.create(projectId, iid, input.body ?? '', {
                  position: gitLabPosition(input.position as ReviewPosition, intent.revision),
                })
              )
            : input.action === 'reply'
              ? await client.execute(api =>
                  api.MergeRequestDiscussions.addNote(
                    projectId,
                    iid,
                    target(context, input, 'thread'),
                    input.body ?? ''
                  )
                )
              : await client.execute(api =>
                  api.MergeRequestNotes.create(projectId, iid, input.body ?? '', {
                    mergeRequestDiffSha: intent.revision.headSha,
                  })
                );
        const note =
          input.action === 'inlineComment'
            ? parseGitLab(threadSchema, response.data).notes[0]
            : parseGitLab(noteSchema, response.data);
        const ref = reference(context, 'comment', String(note.id));
        if (
          note.body !== input.body ||
          String(note.author?.id) !== auth.actor.id ||
          String(note.noteable_id) !== intent.review.reviewId ||
          (input.position && !matchesPosition(note.position, input.position))
        )
          return unresolvedReviewEffect('provider_evidence_mismatch', ref);
        result = completed(ref);
        if (input.action === 'inlineComment') return result;
        break;
      }
      case 'resolveThread':
      case 'reopenThread': {
        const threadId = target(context, input, 'thread');
        const thread = parseGitLab(
          threadSchema,
          (
            await client.execute(api =>
              api.MergeRequestDiscussions.resolve(
                projectId,
                iid,
                threadId,
                input.action === 'resolveThread'
              )
            )
          ).data
        );
        if (
          thread.id !== threadId ||
          !thread.notes.some(note => note.resolvable) ||
          thread.notes.some(
            note => note.resolvable && note.resolved !== (input.action === 'resolveThread')
          )
        )
          return unresolvedReviewEffect(
            'resolution_unconfirmed',
            reference(context, 'thread', threadId)
          );
        result = completed(reference(context, 'thread', threadId));
        break;
      }
      case 'addReaction': {
        const award = parseGitLab(
          awardSchema,
          (
            await client.execute(api =>
              api.MergeRequestNoteAwardEmojis.award(
                projectId,
                iid,
                numeric(target(context, input, 'comment')),
                input.reaction ?? ''
              )
            )
          ).data
        );
        const ref = reference(context, 'reaction', String(award.id));
        if (award.name !== input.reaction || String(award.user.id) !== auth.actor.id)
          return unresolvedReviewEffect('actor_mismatch', ref);
        result = completed(ref);
        break;
      }
      case 'removeReaction':
        await client.execute(api =>
          api.MergeRequestNoteAwardEmojis.remove(
            projectId,
            iid,
            numeric(target(context, input, 'comment')),
            numeric(input.reaction ?? '')
          )
        );
        result = completed(reference(context, 'reaction', input.reaction ?? ''));
        break;
      case 'approve': {
        const approval = parseGitLab(
          z.object({ approved_by: z.array(z.object({ user: GitLabUserSchema })) }),
          (
            await client.execute(api =>
              api.MergeRequestApprovals.approve(projectId, iid, { sha: intent.revision.headSha })
            )
          ).data
        );
        if (!approval.approved_by.some(item => String(item.user.id) === auth.actor.id))
          return unresolvedReviewEffect('approval_unconfirmed');
        return completed(reference(context, 'review', intent.review.reviewId));
      }
      case 'unapprove':
        await client.execute(api => api.MergeRequestApprovals.unapprove(projectId, iid));
        result = completed(reference(context, 'review', intent.review.reviewId));
        break;
      case 'requestChanges': {
        // This state mutation does not require licensed merge blocking.
        const response = parseGitLab(
          z.object({
            data: z
              .object({
                mergeRequestRequestChanges: z
                  .object({
                    errors: z.array(z.string()),
                    mergeRequest: z.object({ id: z.string(), iid: z.string() }).nullable(),
                  })
                  .nullable(),
              })
              .nullable()
              .optional(),
            errors: z.array(z.unknown()).optional(),
          }),
          (await client.requestChanges(iid)).data
        );
        const payload = response.data?.mergeRequestRequestChanges;
        if (response.errors?.length || !payload)
          return unresolvedReviewEffect('request_changes_unconfirmed');
        if (payload.errors.length && !payload.mergeRequest)
          return rejectedReviewEffect('request_changes_rejected');
        if (
          payload.errors.length ||
          payload.mergeRequest?.id !== `gid://gitlab/MergeRequest/${intent.review.reviewId}` ||
          payload.mergeRequest.iid !== intent.review.number
        )
          return unresolvedReviewEffect('request_changes_unconfirmed');
        result = completed(reference(context, 'review', intent.review.reviewId));
        break;
      }
      case 'merge':
      case 'enableAutoMerge': {
        const [major, minor] = (version ?? '0.0').split('.').map(Number);
        const auto = input.action === 'enableAutoMerge';
        const message = [input.commitTitle, input.commitMessage]
          .filter(value => value !== undefined)
          .join('\n\n');
        const response = await client.execute(api =>
          api.MergeRequests.merge(projectId, iid, {
            sha: intent.revision.headSha,
            shouldRemoveSourceBranch: false,
            squash:
              input.squash ?? ['always', 'default_on'].includes(loaded.project.squash_option ?? ''),
            ...(message ? { mergeCommitMessage: message, squashCommitMessage: message } : {}),
            // Old pre-17.11 instances require this form. Remove it only after those instances,
            // old clients/records, and the 30-day ledger window no longer need it.
            ...(auto
              ? major > 17 || (major === 17 && minor >= 11)
                ? { autoMerge: true }
                : { mergeWhenPipelineSucceeds: true }
              : {}),
          })
        );
        const ref = reference(context, 'review', intent.review.reviewId);
        result = pending(ref);
        const current = await snapshot(context);
        if (current.review.sha !== intent.revision.headSha)
          return unresolvedReviewEffect('source_changed', ref);
        if (current.review.state === 'merged') return confirmedReviewEffect(ref);
        if (
          auto &&
          (current.review.merge_when_pipeline_succeeds || current.review.auto_merge_enabled)
        )
          return confirmedReviewEffect(ref);
        return response.status === 202
          ? pending(ref)
          : unresolvedReviewEffect('merge_unconfirmed', ref);
      }
      case 'disableAutoMerge':
        await client.execute(api => api.MergeRequests.cancelOnPipelineSuccess(projectId, iid));
        return reconcile(
          context,
          effect,
          pending(reference(context, 'review', intent.review.reviewId))
        );
      case 'updateBranch': {
        const response = await client.execute(api => api.MergeRequests.rebase(projectId, iid));
        parseGitLab(z.object({ rebase_in_progress: z.boolean() }), response.data);
        const ref = reference(context, 'review', intent.review.reviewId);
        return response.status === 202
          ? pending(ref)
          : unresolvedReviewEffect('rebase_acceptance_unknown', ref);
      }
      case 'deleteBranch': {
        const { source, sourceBranch } = loaded;
        if (!source || !sourceBranch) return unresolvedReviewEffect('source_unavailable');
        await receive(
          source.client.execute(api =>
            api.Branches.remove(source.repository.repositoryId, sourceBranch)
          )
        );
        return completed(reference(context, 'review', intent.review.reviewId));
      }
      default:
        return rejectedReviewEffect('invalid_action');
    }
    const current = await snapshot(context);
    try {
      sameRevision(intent.revision, current.revision);
    } catch {
      return unresolvedReviewEffect(
        'revision_changed_after_write',
        'reference' in result ? result.reference : null
      );
    }
    return result;
  } catch (error) {
    return result && 'reference' in result
      ? unresolvedReviewEffect('postflight_unavailable', result.reference)
      : errorResult(error, dispatched);
  }
}
async function reconcile(
  context: Context,
  effect: Effect,
  stored: ReviewEffectResult | null
): Promise<ReviewEffectResult> {
  const ref = stored && 'reference' in stored ? stored.reference : null;
  const {
    auth,
    request: { intent },
  } = context;
  const { input } = effect;
  try {
    if (
      ref &&
      (ref.provider !== 'gitlab' || (ref.url !== null && ref.url !== intent.review.canonicalUrl))
    )
      return unresolvedReviewEffect('receipt_identity_mismatch');
    const current = await snapshot(context);
    const { client, iid } = current;
    const projectId = current.repository.repositoryId;
    if (
      (input.action === 'merge' || input.action === 'enableAutoMerge') &&
      current.review.state === 'merged' &&
      current.review.sha === intent.revision.headSha
    )
      return confirmedReviewEffect(reference(context, 'review', intent.review.reviewId));
    if (input.action === 'merge')
      return stored?.status === 'accepted'
        ? stored
        : unresolvedReviewEffect('merge_unconfirmed', ref);
    if (
      input.action === 'updateBranch' &&
      stored?.status === 'accepted' &&
      ref?.kind === 'review' &&
      ref.id === intent.review.reviewId
    ) {
      if (current.review.rebase_in_progress) return stored;
      if (current.review.merge_error) return rejectedReviewEffect('rebase_failed');
      if (current.review.rebase_in_progress === false && current.review.merge_error === null)
        return confirmedReviewEffect(ref);
    }
    if (input.action !== 'inlineComment') sameRevision(intent.revision, current.revision);
    if (input.action === 'disableAutoMerge' || input.action === 'enableAutoMerge') {
      const enabled =
        current.review.auto_merge_enabled ?? current.review.merge_when_pipeline_succeeds;
      if (enabled === (input.action === 'enableAutoMerge'))
        return confirmedReviewEffect(reference(context, 'review', intent.review.reviewId));
    }
    if (
      input.action === 'deleteBranch' &&
      input.deletion?.effect === 'delete' &&
      current.review.state === 'merged' &&
      current.review.source_project_id !== null
    ) {
      const deletion = input.deletion;
      const source = await resolveGitLabReviewProject(
        auth,
        String(current.review.source_project_id)
      );
      if (
        deletion.expectedHeadSha !== intent.revision.headSha ||
        deletion.branch !== current.review.source_branch ||
        deletion.branch === source.repository.defaultBranch ||
        deletion.repositoryKey !==
          repositoryResourceKey(auth.userId, {
            repository: source.repository,
            authorization: auth.authorization,
          })
      )
        return unresolvedReviewEffect('source_identity_mismatch', ref);
      try {
        await source.client.execute(api =>
          api.Branches.show(source.repository.repositoryId, deletion.branch)
        );
      } catch (error) {
        if (error instanceof GitLabInteractiveError && error.status === 404)
          return confirmedReviewEffect(reference(context, 'review', intent.review.reviewId));
        throw error;
      }
    }
    // Without a receipt, an absent note cannot prove non-execution. Draft disappearance does not prove publication.
    if (!ref || effect.draft) return unresolvedReviewEffect('receipt_missing', ref);
    if (['comment', 'inlineComment', 'reply'].includes(input.action) && ref.kind === 'comment') {
      const note =
        input.action === 'reply'
          ? parseGitLab(
              threadSchema,
              (
                await client.execute(api =>
                  api.MergeRequestDiscussions.show(projectId, iid, target(context, input, 'thread'))
                )
              ).data
            ).notes.find(item => String(item.id) === ref.id)
          : parseGitLab(
              noteSchema,
              (
                await client.execute(api =>
                  api.MergeRequestNotes.show(projectId, iid, numeric(ref.id))
                )
              ).data
            );
      if (
        note &&
        String(note.id) === ref.id &&
        note.body === input.body &&
        String(note.author?.id) === auth.actor.id &&
        String(note.noteable_id) === intent.review.reviewId &&
        (!input.position || matchesPosition(note.position, input.position))
      )
        return confirmedReviewEffect(ref);
    }
    if (
      (input.action === 'resolveThread' || input.action === 'reopenThread') &&
      ref.kind === 'thread' &&
      ref.id === target(context, input, 'thread')
    ) {
      const thread = parseGitLab(
        threadSchema,
        (await client.execute(api => api.MergeRequestDiscussions.show(projectId, iid, ref.id))).data
      );
      const notes = thread.notes.filter(note => note.resolvable);
      if (
        thread.id === ref.id &&
        notes.length &&
        notes.every(
          note =>
            String(note.noteable_id) === intent.review.reviewId &&
            note.resolved === (input.action === 'resolveThread')
        )
      )
        return confirmedReviewEffect(ref);
    }
    if (
      (input.action === 'addReaction' || input.action === 'removeReaction') &&
      ref.kind === 'reaction'
    ) {
      const response = await client.execute(api =>
        api.MergeRequestNoteAwardEmojis.all(
          projectId,
          iid,
          numeric(target(context, input, 'comment')),
          { perPage: 100, maxPages: 100 }
        )
      );
      if (response.headers['x-next-page'] || /rel="next"/.test(response.headers.link ?? ''))
        throw new GitLabInteractiveError('pagination_limit');
      const award = parseGitLab(z.array(awardSchema), response.data).find(
        value => String(value.id) === ref.id
      );
      if (
        input.action === 'removeReaction'
          ? !award && ref.id === input.reaction
          : award && award.name === input.reaction && String(award.user.id) === auth.actor.id
      )
        return confirmedReviewEffect(ref);
    }
    if (
      (input.action === 'approve' || input.action === 'unapprove') &&
      ref.kind === 'review' &&
      ref.id === intent.review.reviewId
    ) {
      const approvals = parseGitLab(
        z.object({ approved_by: z.array(z.object({ user: GitLabUserSchema })) }),
        (
          await client.execute(api =>
            api.MergeRequestApprovals.showConfiguration(projectId, { mergerequestIId: iid })
          )
        ).data
      );
      if (
        approvals.approved_by.some(value => String(value.user.id) === auth.actor.id) ===
        (input.action === 'approve')
      )
        return confirmedReviewEffect(ref);
    }
    if (
      input.action === 'requestChanges' &&
      ref.kind === 'review' &&
      ref.id === intent.review.reviewId
    ) {
      const reviewers = parseGitLab(
        z.array(z.object({ user: GitLabUserSchema, state: z.string() })),
        (await client.execute(api => api.MergeRequests.showReviewers(projectId, iid))).data
      );
      if (
        reviewers.some(
          value => String(value.user.id) === auth.actor.id && value.state === 'requested_changes'
        )
      )
        return confirmedReviewEffect(ref);
    }
    return unresolvedReviewEffect('provider_outcome_unknown', ref);
  } catch {
    return unresolvedReviewEffect('reconciliation_unavailable', ref);
  }
}
function effects(input: ReviewIntentInput): Effect[] {
  if (input.action !== 'submitReview')
    return [
      { itemId: input.action, input },
      ...(input.deletion?.effect === 'delete' && input.action === 'merge'
        ? [
            {
              itemId: 'deleteBranch',
              input: { action: 'deleteBranch' as const, deletion: input.deletion },
            },
          ]
        : []),
    ];
  const comments = input.comments ?? [];
  const drafts = input.draftReferences ?? [];
  if (
    comments.length > 100 ||
    new Set(comments.map(item => item.itemId)).size !== comments.length ||
    new Set(drafts.map(item => item.id)).size !== drafts.length ||
    drafts.some(
      draft =>
        draft.provider !== 'gitlab' ||
        draft.kind !== 'comment' ||
        !comments.some(comment => comment.itemId === draft.id)
    )
  )
    throw new GitLabInteractiveError('invalid_request');
  return [
    ...comments.map(comment => ({
      itemId: `comment:${comment.itemId}`,
      input: { action: 'inlineComment' as const, body: comment.body, position: comment.position },
      draft: drafts.find(draft => draft.id === comment.itemId),
    })),
    ...(input.body
      ? [{ itemId: 'summary', input: { action: 'comment' as const, body: input.body } }]
      : []),
    ...(input.choice && input.choice !== 'comment'
      ? [{ itemId: 'decision', input: { action: input.choice } }]
      : []),
  ];
}

// Action-specific fields prevent silently dropping editable work or a destructive choice.
const actionFields: Partial<Record<ReviewIntentInput['action'], readonly string[]>> = {
  comment: ['body'],
  inlineComment: ['body', 'position'],
  reply: ['body', 'target'],
  resolveThread: ['target'],
  reopenThread: ['target'],
  addReaction: ['target', 'reaction'],
  removeReaction: ['target', 'reaction'],
  approve: [],
  unapprove: [],
  requestChanges: [],
  updateBranch: [],
  disableAutoMerge: [],
  merge: ['method', 'squash', 'commitTitle', 'commitMessage', 'deletion'],
  enableAutoMerge: ['method', 'squash', 'commitTitle', 'commitMessage'],
  deleteBranch: ['deletion'],
  submitReview: ['comments', 'draftReferences', 'body', 'choice'],
};

/** Supply authorizeGitLabReview authorization for every write and status request, never client-created credentials. */
export async function runGitLabReviewOperation(
  auth: GitLabReviewAuthorization,
  request: ReviewOperationRequest,
  statusOnly = false
): Promise<ReviewMutationResult> {
  const { intent } = request;
  if (
    request.effect ||
    auth.userId !== request.userId ||
    intent.accountId !== auth.userId ||
    intent.actorId !== auth.actor.id ||
    intent.review.repository.provider !== 'gitlab' ||
    repositoryResourceKey(auth.userId, intent.review) !==
      repositoryResourceKey(auth.userId, {
        repository: intent.review.repository,
        authorization: auth.authorization,
      })
  )
    return rejectedReviewEffect('operation_identity_mismatch');
  serializeReviewWriteRequest(intent);
  const input = parseGitLab(ReviewIntentInputSchema, intent.input, 'invalid_request');
  const fields = actionFields[input.action];
  if (!fields || Object.keys(input).some(key => key !== 'action' && !fields.includes(key)))
    throw new GitLabInteractiveError('invalid_request');
  const selected = parseGitLab(ReviewRevisionSchema, intent.revision, 'invalid_request');
  parseGitLab(sha, selected.headSha, 'invalid_request');
  const context = { auth, request };
  const list = effects(input);
  for (const effect of list) {
    parseGitLab(z.string().min(1).max(512), effect.itemId, 'invalid_request');
    const value = effect.input;
    if (['comment', 'inlineComment', 'reply'].includes(value.action) && !value.body?.trim())
      throw new GitLabInteractiveError('invalid_request');
    if (value.action === 'inlineComment' && !value.position)
      throw new GitLabInteractiveError('invalid_request');
    if (value.position) gitLabPosition(value.position, selected);
    if (['reply', 'resolveThread', 'reopenThread'].includes(value.action))
      target(context, value, 'thread');
    if (value.action === 'addReaction' || value.action === 'removeReaction') {
      numeric(target(context, value, 'comment'));
      parseGitLab(z.string().min(1), value.reaction, 'invalid_request');
      if (value.action === 'removeReaction') numeric(value.reaction ?? '');
    }
    if (effect.draft) {
      numeric(effect.draft.id);
      if (
        effect.draft.url !== null &&
        effect.draft.url.split('#')[0] !== intent.review.canonicalUrl
      )
        throw new GitLabInteractiveError('invalid_request');
    }
  }
  if (input.action !== 'submitReview' && list.length === 1)
    return runReviewOperation(request, {
      ...(statusOnly ? {} : { execute: () => perform(context, list[0]) }),
      reconcile: stored => reconcile(context, list[0], stored),
    });
  const items: Extract<ReviewMutationResult, { status: 'partial' }>['items'] = [];
  async function publish(): Promise<ReviewEffectResult> {
    let stopped = false;
    for (const effect of list) {
      const result: ReviewEffectResult = stopped
        ? rejectedReviewEffect('previous_effect_unconfirmed', 'same-key')
        : await runReviewOperation(
            { ...request, effect: { id: effect.itemId, action: effect.input.action } },
            {
              ...(statusOnly ? {} : { execute: () => perform(context, effect) }),
              reconcile: stored => reconcile(context, effect, stored),
            }
          );
      items.push({ itemId: effect.itemId, effect: effect.input.action, result });
      stopped ||= result.status !== 'confirmed';
    }
    return stopped
      ? unresolvedReviewEffect('batch_incomplete')
      : confirmedReviewEffect(
          list.length ? reference(context, 'review', intent.review.reviewId) : null
        );
  }
  // The parent binds the whole batch before any child admission. Only compact parent status is stored.
  const result = await runReviewOperation(request, {
    ...(statusOnly ? {} : { execute: publish }),
    reconcile: publish,
    aggregate: true,
  });
  return items.some(item => item.result.status !== 'confirmed')
    ? { status: 'partial', items, retry: 'unfinished-only', reconciliation: 'required' }
    : result;
}
