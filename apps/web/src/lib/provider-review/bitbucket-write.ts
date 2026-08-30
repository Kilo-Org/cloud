import 'server-only';

import { z } from 'zod';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import {
  BitbucketMergeEvidenceSchema,
  ReviewIntentInputSchema,
  ReviewRevisionSchema,
  serializeReviewWriteRequest,
  type BitbucketMergeEvidence,
  type ProviderReference,
  type ReviewIntentInput,
  type ReviewMutationResult,
  type ReviewOverview,
  type ReviewPosition,
  type ReviewRevision,
} from '@kilocode/app-shared/provider-review';
import {
  BitbucketInteractiveClientError,
  type BitbucketInteractiveRequest,
} from '@/lib/integrations/platforms/bitbucket/interactive-client';
import {
  BitbucketPathSchema,
  BitbucketUuidSchema,
  assertBitbucketReviewIdentity,
  parseBitbucket,
  type BitbucketReviewAuthorization,
} from './bitbucket-authorization';
import { getBitbucketReview, listBitbucketFiles } from './bitbucket-read';
import {
  confirmedReviewEffect,
  rejectedReviewEffect,
  unresolvedReviewEffect,
  runReviewOperation,
  type ReviewEffectResult,
  type ReviewOperationRequest,
} from './operation';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const providerSha = z.string().regex(/^[a-f0-9]{7,40}$/);
const revisionSchema = ReviewRevisionSchema.extend({
  headSha: sha,
  targetHeadSha: sha,
  baseSha: sha.nullable(),
  startSha: z.null(),
});
const endpoint = z.object({
  repository: z
    .object({
      uuid: BitbucketUuidSchema,
      full_name: z.string(),
      workspace: z.object({ uuid: BitbucketUuidSchema }).optional(),
    })
    .nullable(),
  branch: z.object({ name: BitbucketPathSchema }).nullable(),
  commit: z.object({ hash: providerSha }),
});
const reviewSchema = z.object({
  type: z.literal('pullrequest'),
  id,
  state: z.enum(['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']),
  links: z.object({ html: z.object({ href: z.string() }) }),
  source: endpoint,
  destination: endpoint,
  merge_commit: z.object({ hash: providerSha }).nullish(),
});
const inlineSchema = z.object({
  path: BitbucketPathSchema,
  from: id.nullish(),
  to: id.nullish(),
  start_from: id.nullish(),
  start_to: id.nullish(),
});
const commentSchema = z.object({
  type: z.literal('pullrequest_comment'),
  id,
  content: z.object({ raw: z.string() }).nullish(),
  parent: z.object({ id }).nullish(),
  inline: inlineSchema.nullish(),
  pullrequest: z.object({ id }).optional(),
  user: z.object({ uuid: BitbucketUuidSchema }).nullish(),
  deleted: z.boolean().optional(),
  resolution: z.object({}).nullish(),
});
const methodSchema = z.enum([
  'merge_commit',
  'squash',
  'fast_forward',
  'squash_fast_forward',
  'rebase_fast_forward',
  'rebase_merge',
]);
const fields: Partial<Record<ReviewIntentInput['action'], readonly string[]>> = {
  comment: ['body'],
  inlineComment: ['body', 'position'],
  reply: ['body', 'target'],
  resolveThread: ['target'],
  reopenThread: ['target'],
  approve: [],
  unapprove: [],
  requestChanges: [],
  removeChangeRequest: [],
  merge: ['method', 'commitTitle', 'commitMessage', 'deletion'],
  submitReview: ['body', 'comments', 'choice'],
};
type Context = { auth: BitbucketReviewAuthorization; request: ReviewOperationRequest };
type Effect = { itemId: string; input: ReviewIntentInput };
function conflict(): never {
  throw new BitbucketInteractiveClientError('conflict');
}
function heads(expected: ReviewRevision, actual: ReviewRevision) {
  if (expected.headSha !== actual.headSha || expected.targetHeadSha !== actual.targetHeadSha)
    conflict();
}
function path({ auth, request }: Context) {
  return {
    ...auth.path,
    pull_request_id: parseBitbucket(id, Number(request.intent.review.number), 'invalid_request'),
  };
}
function reference(
  context: Context,
  kind: ProviderReference['kind'],
  value = context.request.intent.review.reviewId
): ProviderReference {
  const url = context.request.intent.review.canonicalUrl;
  return {
    provider: 'bitbucket',
    kind,
    id: value,
    url: kind === 'comment' || kind === 'thread' ? `${url}/_/diff#comment-${value}` : url,
  };
}
function target(context: Context, input: ReviewIntentInput) {
  const value = input.target;
  if (
    !value ||
    value.provider !== 'bitbucket' ||
    !['comment', 'thread'].includes(value.kind) ||
    !/^[1-9]\d*$/.test(value.id) ||
    (value.url !== null && value.url !== reference(context, value.kind, value.id).url)
  )
    throw new BitbucketInteractiveClientError('invalid_request');
  return parseBitbucket(id, Number(value.id), 'invalid_request');
}
function inline(position: ReviewPosition, revision: ReviewRevision) {
  const native = position.native;
  if (native.provider !== 'bitbucket') throw new BitbucketInteractiveClientError('invalid_request');
  parseBitbucket(revisionSchema, position.revision, 'invalid_request');
  heads(revision, position.revision);
  if (
    (revision.baseSha !== null && position.revision.baseSha !== revision.baseSha) ||
    position.revision.startSha !== null ||
    position.line !== (position.side === 'old' ? native.from : native.to) ||
    position.startLine !== (position.startSide === 'old' ? native.startFrom : native.startTo) ||
    (position.startLine === undefined &&
      (native.startFrom !== undefined || native.startTo !== undefined)) ||
    (position.startSide === position.side &&
      position.startLine !== undefined &&
      position.startLine > position.line)
  )
    conflict();
  return {
    path: parseBitbucket(
      BitbucketPathSchema,
      position.side === 'old' ? position.oldPath : position.newPath,
      'invalid_request'
    ),
    ...(native.from === undefined ? {} : { from: native.from }),
    ...(native.to === undefined ? {} : { to: native.to }),
    ...(native.startFrom === undefined ? {} : { start_from: native.startFrom }),
    ...(native.startTo === undefined ? {} : { start_to: native.startTo }),
  };
}
function review(context: Context, value: unknown) {
  const result = parseBitbucket(reviewSchema, value);
  const expected = context.auth.repository;
  if (
    result.id !== path(context).pull_request_id ||
    result.links.html.href !== context.request.intent.review.canonicalUrl ||
    result.destination.repository?.uuid !== expected.repositoryId ||
    result.destination.repository.full_name !== expected.fullName ||
    (result.destination.repository.workspace &&
      result.destination.repository.workspace.uuid !== expected.workspaceUuid)
  )
    throw new BitbucketInteractiveClientError('repository_mismatch');
  return result;
}
async function snapshot(context: Context) {
  const response = await context.auth.client.execute({
    operation: 'pullRequest',
    params: {
      path: path(context),
      query: { fields: '+source.repository.workspace,+destination.repository.workspace' },
    },
  });
  if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  return review(context, response.data);
}
async function fullSha(context: Context, hash: string) {
  if (hash.length === 40) return hash;
  const response = await context.auth.client.execute({
    operation: 'commit',
    params: { path: { ...context.auth.path, commit: hash } },
  });
  if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const commit = parseBitbucket(z.object({ hash: sha }), response.data);
  if (!commit.hash.startsWith(hash)) conflict();
  return commit.hash;
}
async function fullSourceSha(context: Context, source: z.infer<typeof endpoint>) {
  const hash = source.commit.hash;
  if (hash.length === 40) return hash;
  let next: string | undefined;
  let candidate: string | undefined;
  const seen = new Set<string>();
  do {
    // Destination authorization permits the PR's commits, not an arbitrary source repository lookup.
    const response = await context.auth.client.execute({
      operation: 'commits',
      params: { path: path(context) },
      ...(next ? { next } : {}),
    });
    if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
    const page = parseBitbucket(
      z.object({ values: z.array(z.object({ hash: sha })).max(50) }),
      response.data
    );
    for (const commit of page.values) {
      if (!commit.hash.startsWith(hash)) continue;
      if (candidate && candidate !== commit.hash)
        throw new BitbucketInteractiveClientError('temporarily_unavailable');
      candidate = commit.hash;
    }
    next = response.next;
    if (next) {
      if (seen.has(next)) throw new BitbucketInteractiveClientError('invalid_pagination');
      if (seen.size >= 99) throw new BitbucketInteractiveClientError('page_limit_exceeded');
      seen.add(next);
    }
  } while (next);
  if (candidate) return candidate;
  // Closed same-repository PRs can have an empty commits list after source deletion.
  if (source.repository?.uuid === context.auth.repository.repositoryId)
    return fullSha(context, hash);
  throw new BitbucketInteractiveClientError('temporarily_unavailable');
}
async function checkHeads(context: Context, value: z.infer<typeof reviewSchema>) {
  heads(context.request.intent.revision, {
    headSha: await fullSourceSha(context, value.source),
    targetHeadSha: await fullSha(context, value.destination.commit.hash),
    baseSha: null,
    startSha: null,
  });
}
async function comment(context: Context, commentId: number) {
  const response = await context.auth.client.execute({
    operation: 'comment',
    params: { path: { ...path(context), comment_id: commentId } },
  });
  if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
  const value = parseBitbucket(commentSchema, response.data);
  if (
    value.id !== commentId ||
    value.deleted ||
    (value.pullrequest && value.pullrequest.id !== path(context).pull_request_id)
  )
    conflict();
  return value;
}
function checkCapability(overview: ReviewOverview, action: ReviewIntentInput['action']) {
  const value = overview.authorization.capabilities[action];
  if (value.permission === 'forbidden')
    throw new BitbucketInteractiveClientError('insufficient_permissions');
  if (
    value.support !== 'supported' ||
    value.version !== 'available' ||
    value.license !== 'available' ||
    value.restrictions.length
  )
    conflict();
  // Unknown OAuth merge permission is not permission denial. The provider enforces it on the write.
}
async function preflight(context: Context, input: ReviewIntentInput) {
  const {
    auth,
    request: { intent },
  } = context;
  const overview = await getBitbucketReview(auth, intent.review.number);
  assertBitbucketReviewIdentity(auth, overview.identity);
  heads(intent.revision, overview.revision);
  checkCapability(overview, input.action);
  if (input.position) {
    let cursor;
    let found = false;
    do {
      const page = await listBitbucketFiles(auth, intent.review, intent.revision, cursor);
      found = page.items.some(
        file =>
          file.oldPath === input.position?.oldPath &&
          file.newPath === input.position.newPath &&
          file.revision.baseSha === input.position.revision.baseSha
      );
      cursor = page.nextCursor;
    } while (!found && cursor);
    if (!found) conflict();
  }
  if (input.target) await comment(context, target(context, input));
  if (input.action === 'merge') {
    if (
      overview.state !== 'open' ||
      !overview.merge.methods.some(method => method.id === input.method)
    )
      conflict();
    if (input.deletion?.effect === 'delete') {
      checkCapability(overview, 'deleteBranch');
      const source = overview.source;
      if (
        !source.repository ||
        source.repository.repositoryId !== auth.repository.repositoryId ||
        source.repository.provider !== 'bitbucket' ||
        source.repository.workspaceUuid !== auth.repository.workspaceUuid ||
        !source.branch ||
        source.branch === overview.target.branch ||
        !auth.repository.defaultBranch ||
        source.branch === auth.repository.defaultBranch ||
        input.deletion.branch !== source.branch ||
        input.deletion.expectedHeadSha !== intent.revision.headSha ||
        input.deletion.repositoryKey !==
          repositoryResourceKey(auth.userId, {
            repository: source.repository,
            authorization: auth.authorization,
          })
      )
        conflict();
      const response = await auth.client.execute({
        operation: 'branch',
        params: { path: { ...auth.path, name: source.branch } },
      });
      if (response.status !== 200) conflict();
      const branch = parseBitbucket(
        z.object({ name: z.string(), target: z.object({ hash: providerSha }) }),
        response.data
      );
      if (
        branch.name !== source.branch ||
        (await fullSha(context, branch.target.hash)) !== intent.revision.headSha
      )
        conflict();
    }
  }
  const before = await snapshot(context);
  await checkHeads(context, before);
  if (
    ['approve', 'unapprove', 'requestChanges', 'removeChangeRequest', 'merge'].includes(
      input.action
    ) &&
    before.state !== 'OPEN'
  )
    conflict();
  if (
    before.source.repository?.uuid !== overview.source.repository?.repositoryId ||
    (before.source.branch?.name ?? null) !== overview.source.branch ||
    before.destination.branch?.name !== overview.target.branch
  )
    conflict();
  return before;
}
function taskReference(context: Context, location: string): ProviderReference {
  const url = new URL(location);
  // The API returns canonical slug links even when the authorized request uses UUIDs.
  const repositories = [
    `${encodeURIComponent(context.auth.path.workspace)}/${encodeURIComponent(context.auth.path.repo_slug)}`,
    context.auth.repository.fullName.split('/').map(encodeURIComponent).join('/'),
  ];
  const prefix = repositories
    .map(
      repository =>
        `/2.0/repositories/${repository}/pullrequests/${path(context).pull_request_id}/merge/task-status/`
    )
    .find(value => url.pathname.startsWith(value));
  if (!prefix) throw new BitbucketInteractiveClientError('invalid_response');
  const taskId = decodeURIComponent(url.pathname.slice(prefix.length));
  if (
    url.origin !== 'https://api.bitbucket.org' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_{}.-]+$/.test(taskId) ||
    taskId === '.' ||
    taskId === '..'
  )
    throw new BitbucketInteractiveClientError('invalid_response');
  return { provider: 'bitbucket', kind: 'merge-task', id: taskId, url: url.href };
}
function pending(ref: ProviderReference): ReviewEffectResult {
  return {
    status: 'accepted',
    reference: ref,
    retry: 'reconcile',
    reconciliation: 'pending',
    task: {
      reference: { ...ref, provider: 'bitbucket', kind: 'merge-task' },
      state: 'pending',
      mergeCommitSha: null,
      error: null,
    },
  };
}
function mergeIdentity(value: z.infer<typeof reviewSchema>): BitbucketMergeEvidence {
  const identity = (value: z.infer<typeof endpoint>) => ({
    repositoryId: value.repository?.uuid,
    workspaceUuid: value.repository?.workspace?.uuid,
    fullName: value.repository?.full_name,
    branch: value.branch?.name,
  });
  return parseBitbucket(BitbucketMergeEvidenceSchema, {
    source: identity(value.source),
    destination: identity(value.destination),
  });
}
async function merged(
  context: Context,
  evidence: BitbucketMergeEvidence | null,
  returned?: unknown
): Promise<ReviewEffectResult> {
  const ref = reference(context, 'review');
  if (!evidence) return unresolvedReviewEffect('merge_identity_unavailable', ref);
  const current = await snapshot(context);
  const result = returned === undefined ? current : review(context, returned);
  if (
    result.state !== 'MERGED' ||
    current.state !== 'MERGED' ||
    !result.merge_commit ||
    !current.merge_commit
  )
    return unresolvedReviewEffect('merge_not_confirmed', ref);
  for (const value of [result, current]) {
    for (const side of ['source', 'destination'] as const) {
      const endpoint = value[side];
      const expected = evidence[side];
      if (
        endpoint.repository?.uuid !== expected.repositoryId ||
        endpoint.repository.workspace?.uuid !== expected.workspaceUuid ||
        endpoint.repository.full_name !== expected.fullName ||
        endpoint.branch?.name !== expected.branch
      )
        conflict();
    }
  }
  await checkHeads(context, result);
  await checkHeads(context, current);
  if (
    (await fullSha(context, result.merge_commit.hash)) !==
    (await fullSha(context, current.merge_commit.hash))
  )
    conflict();
  return confirmedReviewEffect(ref);
}
async function reconcile(
  context: Context,
  input: ReviewIntentInput,
  stored: ReviewEffectResult | null,
  evidence?: BitbucketMergeEvidence | null
): Promise<ReviewEffectResult> {
  const ref = stored && 'reference' in stored ? stored.reference : null;
  try {
    if (input.action === 'merge') {
      if (!evidence) return unresolvedReviewEffect('merge_identity_unavailable', ref);
      if (ref?.kind !== 'merge-task') return await merged(context, evidence);
      if (ref.provider !== 'bitbucket' || !ref.url || taskReference(context, ref.url).id !== ref.id)
        conflict();
      const response = await context.auth.client.execute({
        operation: 'mergeTask',
        params: { path: { ...path(context), task_id: ref.id } },
      });
      if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
      const task = parseBitbucket(
        z.object({
          task_status: z.enum(['PENDING', 'SUCCESS']),
          links: z.object({ self: z.object({ href: z.string() }) }),
          merge_result: z.unknown().optional(),
        }),
        response.data
      );
      if (taskReference(context, task.links.self.href).id !== ref.id) conflict();
      if (task.task_status === 'PENDING') return pending(ref);
      if (!task.merge_result) return unresolvedReviewEffect('merge_result_missing', ref);
      return await merged(context, evidence, task.merge_result);
    }
    if (!ref) return unresolvedReviewEffect('provider_receipt_missing');
    if (ref.kind === 'comment' || ref.kind === 'thread') await comment(context, Number(ref.id));
    await checkHeads(context, await snapshot(context));
    // Bitbucket PR comments and participant states have no immutable reviewed SHA. Matching
    // pre/post heads cannot upgrade a reference chosen before dispatch into a provider receipt.
    return stored?.status === 'unresolved' && stored.reason === 'no_atomic_revision_guard'
      ? stored
      : unresolvedReviewEffect('provider_outcome_unknown', ref);
  } catch {
    return unresolvedReviewEffect('provider_outcome_unknown', ref);
  }
}
async function perform(
  context: Context,
  input: ReviewIntentInput,
  persistMergeEvidence?: (evidence: BitbucketMergeEvidence) => Promise<void>
): Promise<ReviewEffectResult> {
  let dispatched = false,
    responded = false;
  let ref: ProviderReference | null = null;
  try {
    const before = await preflight(context, input);
    const evidence = input.action === 'merge' ? mergeIdentity(before) : null;
    const params = { path: path(context) };
    let operation: BitbucketInteractiveRequest;
    switch (input.action) {
      case 'comment':
      case 'inlineComment':
      case 'reply':
        operation = {
          operation: 'createComment',
          params,
          body: {
            type: 'pullrequest_comment',
            content: { raw: input.body },
            ...(input.position
              ? { inline: inline(input.position, context.request.intent.revision) }
              : {}),
            ...(input.action === 'reply'
              ? { parent: { type: 'comment', id: target(context, input) } }
              : {}),
          },
        };
        break;
      case 'resolveThread':
      case 'reopenThread':
        ref = reference(context, 'thread', String(target(context, input)));
        operation = {
          operation: input.action === 'resolveThread' ? 'resolveComment' : 'reopenComment',
          params: { path: { ...params.path, comment_id: target(context, input) } },
        };
        break;
      case 'approve':
      case 'unapprove':
      case 'requestChanges':
      case 'removeChangeRequest':
        ref = reference(context, 'review');
        operation = { operation: input.action, params };
        break;
      case 'merge': {
        const message = [input.commitTitle, input.commitMessage]
          .filter(value => value !== undefined)
          .join('\n\n');
        if (Buffer.byteLength(message, 'utf8') > 128 * 1024)
          throw new BitbucketInteractiveClientError('request_too_large');
        operation = {
          operation: 'merge',
          params,
          body: {
            type: 'pullrequest_merge_parameters',
            merge_strategy: methodSchema.parse(input.method),
            close_source_branch: input.deletion?.effect === 'delete',
            ...(message ? { message } : {}),
          },
        };
        break;
      }
      default:
        throw new BitbucketInteractiveClientError('invalid_request');
    }
    if (evidence) {
      if (!persistMergeEvidence) throw new Error('Merge evidence persistence is required');
      await persistMergeEvidence(evidence);
    }
    // No If-Match or expected-head header exists for these Bitbucket operations.
    dispatched = true;
    const response = await context.auth.client.execute(operation);
    responded = true;
    if (input.action === 'merge') {
      if (response.status === 202) return pending(taskReference(context, response.location));
      if (response.status !== 200) throw new BitbucketInteractiveClientError('invalid_response');
      ref = reference(context, 'review');
      return await merged(context, evidence, response.data);
    }
    if (operation.operation === 'createComment') {
      if (response.status !== 201) throw new BitbucketInteractiveClientError('invalid_response');
      const value = parseBitbucket(commentSchema, response.data);
      if (
        value.pullrequest?.id !== params.path.pull_request_id ||
        value.content?.raw !== input.body ||
        value.deleted ||
        (value.parent?.id ?? null) !== (input.action === 'reply' ? target(context, input) : null)
      )
        conflict();
      const selected = input.position
        ? inline(input.position, context.request.intent.revision)
        : null;
      if (
        selected
          ? !value.inline ||
            (['path', 'from', 'to', 'start_from', 'start_to'] as const).some(
              key => (value.inline?.[key] ?? undefined) !== selected[key]
            )
          : value.inline != null
      )
        conflict();
      if (
        context.auth.credentialKind === 'bitbucketOAuth' &&
        value.user?.uuid !== context.auth.actor.id
      )
        conflict();
      ref = reference(context, 'comment', String(value.id));
    } else if (input.action === 'approve' || input.action === 'requestChanges') {
      const participant = parseBitbucket(
        z.object({
          user: z.object({ uuid: BitbucketUuidSchema }),
          state: z.enum(['approved', 'changes_requested']).nullish(),
          approved: z.boolean().optional(),
        }),
        response.data
      );
      if (
        response.status !== 200 ||
        (input.action === 'approve'
          ? !(participant.state === 'approved' || participant.approved)
          : participant.state !== 'changes_requested') ||
        (context.auth.credentialKind === 'bitbucketOAuth' &&
          participant.user.uuid !== context.auth.actor.id)
      )
        conflict();
    } else if (input.action === 'resolveThread' || input.action === 'reopenThread') {
      const value = await comment(context, target(context, input));
      if ((value.resolution != null) !== (input.action === 'resolveThread')) conflict();
    } else if (response.status !== 204)
      throw new BitbucketInteractiveClientError('invalid_response');
    const after = await snapshot(context);
    await checkHeads(context, after);
    if (
      before.state !== after.state ||
      before.source.repository?.uuid !== after.source.repository?.uuid ||
      before.source.branch?.name !== after.source.branch?.name ||
      before.destination.branch?.name !== after.destination.branch?.name
    )
      conflict();
    return unresolvedReviewEffect('no_atomic_revision_guard', ref);
  } catch (error) {
    if (
      error instanceof BitbucketInteractiveClientError &&
      (!dispatched ||
        (!responded &&
          [
            'insufficient_permissions',
            'authentication_rejected',
            'not_connected',
            // reconnect_required can also come from the authorization fence after a write.
            'conflict',
            'not_found',
            'request_too_large',
          ].includes(error.code)))
    )
      return rejectedReviewEffect(
        error.code,
        [
          'temporarily_unavailable',
          'provider_unavailable',
          'rate_limited',
          'request_timed_out',
          'transport_failed',
        ].includes(error.code)
          ? 'same-key'
          : 'never'
      );
    return dispatched
      ? unresolvedReviewEffect('provider_outcome_unknown', ref)
      : rejectedReviewEffect('preflight_unavailable', 'same-key');
  }
}
async function deletion(context: Context, merge: ReviewEffectResult): Promise<ReviewEffectResult> {
  const selected = context.request.intent.input.deletion;
  if (merge.status !== 'confirmed' || !selected)
    return unresolvedReviewEffect('merge_not_confirmed');
  // close_source_branch requests deletion but returns no deletion receipt. Observe separately;
  // never issue a second delete against a branch that can have advanced or been recreated.
  try {
    await context.auth.client.execute({
      operation: 'branch',
      params: { path: { ...context.auth.path, name: selected.branch } },
    });
    return unresolvedReviewEffect('source_branch_still_present');
  } catch (error) {
    if (error instanceof BitbucketInteractiveClientError && error.code === 'not_found') {
      try {
        // A masked repository-access failure is not evidence that the branch was deleted.
        const current = await snapshot(context);
        if (current.state === 'MERGED') return confirmedReviewEffect(reference(context, 'review'));
      } catch {
        /* Keep the confirmed merge separate from unavailable deletion evidence. */
      }
    }
    return unresolvedReviewEffect('source_branch_deletion_unknown');
  }
}

export type BitbucketReviewOperationRequest = ReviewOperationRequest & {
  intent: { revision: z.infer<typeof revisionSchema> };
};

/**
 * Use fresh authorizeBitbucketReview authorization for submission and status checks.
 * Bitbucket has no atomic expected-head guard. Comments and participant receipts remain
 * revision-unresolved even when both heads match; merge confirmation requires provider readback.
 */
export async function runBitbucketReviewOperation(
  auth: BitbucketReviewAuthorization,
  request: BitbucketReviewOperationRequest,
  statusOnly = false
): Promise<ReviewMutationResult> {
  const { intent } = request;
  if (
    request.effect ||
    request.userId !== auth.userId ||
    intent.accountId !== auth.userId ||
    intent.actorId !== auth.actor.id
  )
    return rejectedReviewEffect('operation_identity_mismatch');
  assertBitbucketReviewIdentity(auth, intent.review);
  serializeReviewWriteRequest(intent);
  parseBitbucket(revisionSchema, intent.revision, 'invalid_request');
  const input = parseBitbucket(ReviewIntentInputSchema, intent.input, 'invalid_request');
  const allowed = fields[input.action];
  if (!allowed || Object.keys(input).some(key => key !== 'action' && !allowed.includes(key)))
    throw new BitbucketInteractiveClientError('invalid_request');
  const comments = input.comments ?? [];
  if (
    comments.length > 100 ||
    new Set(comments.map(value => value.itemId)).size !== comments.length
  )
    throw new BitbucketInteractiveClientError('invalid_request');
  const effects: Effect[] =
    input.action === 'submitReview'
      ? [
          ...comments.map(value => ({
            itemId: `comment:${value.itemId}`,
            input: { action: 'inlineComment' as const, body: value.body, position: value.position },
          })),
          ...(input.body
            ? [{ itemId: 'summary', input: { action: 'comment' as const, body: input.body } }]
            : []),
          ...(input.choice && input.choice !== 'comment'
            ? [{ itemId: 'decision', input: { action: input.choice } }]
            : []),
        ]
      : [{ itemId: input.action, input }];
  const context = { auth, request };
  for (const effect of effects) {
    parseBitbucket(z.string().min(1).max(512), effect.itemId, 'invalid_request');
    if (
      ['comment', 'inlineComment', 'reply'].includes(effect.input.action) &&
      !effect.input.body?.trim()
    )
      throw new BitbucketInteractiveClientError('invalid_request');
    if (effect.input.action === 'inlineComment' && !effect.input.position)
      throw new BitbucketInteractiveClientError('invalid_request');
    if (effect.input.position) inline(effect.input.position, intent.revision);
    if (['reply', 'resolveThread', 'reopenThread'].includes(effect.input.action))
      target(context, effect.input);
  }
  if (input.action === 'merge') parseBitbucket(methodSchema, input.method, 'invalid_request');
  const execute = (effect: Effect, child: boolean, reconcileOnly = statusOnly) =>
    runReviewOperation(
      child ? { ...request, effect: { id: effect.itemId, action: effect.input.action } } : request,
      {
        ...(reconcileOnly
          ? {}
          : {
              execute: (
                persistMergeEvidence?: (evidence: BitbucketMergeEvidence) => Promise<void>
              ) => perform(context, effect.input, persistMergeEvidence),
            }),
        reconcile: (stored, evidence) => reconcile(context, effect.input, stored, evidence),
      }
    );
  if (input.action !== 'submitReview' && input.deletion?.effect !== 'delete')
    return execute(effects[0], false);
  const items: Extract<ReviewMutationResult, { status: 'partial' }>['items'] = [];
  const publish = async (reconcileOnly = statusOnly): Promise<ReviewEffectResult> => {
    let stopped = false;
    for (const effect of effects) {
      const result = stopped
        ? rejectedReviewEffect('previous_effect_unconfirmed', 'same-key')
        : await execute(effect, true, reconcileOnly);
      items.push({ itemId: effect.itemId, effect: effect.input.action, result });
      // A verified receipt permits the other independent effects, but never claims atomic review success.
      stopped ||=
        result.status !== 'confirmed' &&
        !(result.status === 'unresolved' && result.reason === 'no_atomic_revision_guard');
      if (effect.input.action === 'merge' && input.deletion?.effect === 'delete') {
        const observe = () => deletion(context, result);
        items.push({
          itemId: 'deleteBranch',
          effect: 'deleteBranch',
          result: await runReviewOperation(
            { ...request, effect: { id: 'deleteBranch', action: 'deleteBranch' } },
            {
              ...(reconcileOnly ? {} : { execute: observe }),
              reconcile: observe,
            }
          ),
        });
      }
    }
    return items.some(item => item.result.status !== 'confirmed')
      ? unresolvedReviewEffect('batch_incomplete')
      : confirmedReviewEffect(effects.length ? reference(context, 'review') : null);
  };
  const result = await runReviewOperation(request, {
    ...(statusOnly ? {} : { execute: () => publish() }),
    reconcile: () => publish(),
    aggregate: true,
  });
  // Old aggregate confirmations cannot replace the merge effect's preflight evidence.
  // Retain this fallback until old clients/records disappear and the 30-day ledger window expires.
  // Status-only child checks also prevent a missing legacy child row from admitting another write.
  if (input.action === 'merge' && result.status === 'confirmed' && items.length === 0)
    await publish(true);
  return items.some(item => item.result.status !== 'confirmed')
    ? { status: 'partial', items, retry: 'unfinished-only', reconciliation: 'required' }
    : result;
}
