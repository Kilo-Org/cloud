import { z } from 'zod';
import {
  watchPrDefaultTrustedBotLogins,
  type WatchPrPolicy,
} from '@kilocode/db/cloud-agent-pr-maintenance';
import {
  hasWatchPrMaintenanceReplyMarker,
  watchPrContentFingerprint,
  watchPrFeedbackContent,
} from './watch-pr-feedback-content';
export { watchPrContentFingerprint } from './watch-pr-feedback-content';

const id = z
  .union([z.number().int().positive().safe(), z.string().regex(/^\d{1,20}$/)])
  .transform(String);
const sha = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform(value => value.toLowerCase());
const timestamp = z.string().datetime({ offset: true });
const ref = z.string().min(1).max(1024);
export function truncateWatchPrBody(value: string | null, limit = 12_000) {
  const withoutNulls = (value ?? '').replaceAll(String.fromCharCode(0), '');
  const truncated = withoutNulls.slice(0, limit);
  let sanitized = '';
  for (let index = 0; index < truncated.length; index++) {
    const code = truncated.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = truncated.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += truncated.charAt(index) + truncated.charAt(index + 1);
        index++;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      sanitized += truncated.charAt(index);
    }
  }
  return sanitized;
}
const body = z.string().max(1_000_000).nullable();
const actor = z.object({
  id,
  login: z.string().max(100).optional(),
  type: z.string().max(100).optional(),
});
const envelope = z.object({ installation: z.object({ id }), repository: z.object({ id }) });
const prIdentity = z.object({ number: z.number().int().positive() });
const branch = z.object({ ref, sha, repo: z.object({ id }).nullable() });
const prPayload = envelope.extend({
  action: z.string().max(100),
  before: sha.optional(),
  pull_request: prIdentity.extend({
    state: z.enum(['open', 'closed']),
    merged: z.boolean().optional(),
    updated_at: timestamp,
    head: branch,
    base: branch,
    title: z.string().max(1000).optional(),
    body: body.optional(),
  }),
});
const commentPayload = envelope.extend({
  action: z.enum(['created', 'edited', 'deleted']),
  pull_request: prIdentity,
  comment: z.object({
    id,
    body,
    user: actor,
    updated_at: timestamp,
    commit_id: sha,
    author_association: z.string().max(100).optional(),
    html_url: z.string().url().max(2000).optional(),
    in_reply_to_id: id.optional(),
    node_id: z.string().max(200).optional(),
  }),
});
const issueCommentPayload = envelope.extend({
  action: z.enum(['created', 'edited', 'deleted']),
  issue: prIdentity.extend({ pull_request: z.object({ url: z.string() }) }),
  comment: commentPayload.shape.comment.omit({ commit_id: true }),
});
const threadPayload = envelope.extend({
  action: z.enum(['resolved', 'unresolved']),
  pull_request: prIdentity,
  thread: z.object({
    node_id: z.string().min(1).max(200),
    updated_at: timestamp.optional(),
    comments: z.array(commentPayload.shape.comment).max(100),
  }),
});
const reviewPayload = envelope.extend({
  action: z.enum(['submitted', 'edited', 'dismissed']),
  pull_request: prIdentity,
  review: z.object({
    id,
    body,
    user: actor,
    state: z.string().max(100),
    commit_id: sha,
    submitted_at: timestamp.nullable(),
    updated_at: timestamp.optional(),
    author_association: z.string().max(100).optional(),
    html_url: z.string().url().max(2000).optional(),
  }),
});
const checkPayload = envelope.extend({
  action: z.string().max(100),
  check_run: z.object({
    id,
    head_sha: sha,
    name: z.string().min(1).max(512),
    app: z.object({ id }),
    check_suite: z.object({ id }).nullable().optional(),
    status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
    conclusion: z.string().max(100).nullable(),
    started_at: timestamp.nullable(),
    completed_at: timestamp.nullable(),
    run_attempt: z.number().int().positive().optional(),
    pull_requests: z.array(prIdentity).max(100).default([]),
    details_url: z.string().url().max(2000).nullable().optional(),
  }),
});
const statusPayload = envelope.extend({
  id,
  sha,
  context: z.string().min(1).max(512),
  state: z.enum(['pending', 'success', 'failure', 'error']),
  updated_at: timestamp,
  creator: actor.optional(),
  target_url: z.string().url().max(2000).nullable().optional(),
});
const pushPayload = envelope.extend({
  ref,
  before: sha,
  after: sha,
  deleted: z.boolean(),
  forced: z.boolean().optional(),
});

type EventIdentity = { installationId: string; repositoryId: string };
export const watchPrCiEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('check'),
    installationId: id,
    repositoryId: id,
    prNumbers: z.array(z.number().int().positive()).max(100),
    name: z.string().max(512).optional(),
    detailsUrl: z.string().url().max(2000).nullable().optional(),
    key: z.string().max(1200),
    objectId: id,
    sha,
    updatedAt: timestamp.nullable(),
    startedAt: timestamp.nullable(),
    attempt: z.number().int().positive(),
    state: z.string().max(100),
    conclusion: z.string().max(100).nullable(),
  }),
  z.object({
    kind: z.literal('status'),
    installationId: id,
    repositoryId: id,
    key: z.string().max(1200),
    objectId: id,
    sha,
    updatedAt: timestamp,
    state: z.string().max(100),
    name: z.string().max(512).optional(),
    detailsUrl: z.string().url().max(2000).nullable().optional(),
  }),
]);
export type WatchPrCiEvent = z.infer<typeof watchPrCiEventSchema>;

export type WatchPrEvent = EventIdentity &
  (
    | {
        kind: 'pull_request';
        prNumber: number;
        action: string;
        updatedAt: string;
        headSha: string;
        baseSha: string;
        headRef: string;
        baseRef: string;
        headRepositoryId: string | null;
        baseRepositoryId: string | null;
        before?: string;
        closed: boolean;
        merged: boolean;
        purpose?: { title: string; body: string };
      }
    | {
        kind: 'feedback';
        prNumber: number;
        key: string;
        action: string;
        updatedAt: string | null;
        sha: string;
        actorId: string;
        actorLogin?: string;
        actorType?: string;
        authorAssociation?: string;
        source?: 'review_comment' | 'review' | 'conversation_comment';
        sourceId?: string;
        rootId?: string;
        threadId?: string;
        url?: string;
        body: string;
        contentFingerprint?: string;
        bodyTruncated?: boolean;
        state: string;
        reviewAction?: 'submitted' | 'edited' | 'dismissed';
      }
    | WatchPrCiEvent
    | {
        kind: 'thread';
        prNumber: number;
        threadId: string;
        rootIds: string[];
        resolved: boolean;
        updatedAt: string | null;
      }
    | {
        kind: 'push';
        ref: string;
        before: string;
        after: string;
        deleted: boolean;
        changedFiles?: string[];
        filesComplete?: boolean;
      }
  );

export function normalizeWatchPrEvent(eventType: string, payload: unknown): WatchPrEvent | null {
  if (eventType === 'pull_request') {
    const parsed = prPayload.safeParse(payload);
    if (!parsed.success) return null;
    const { pull_request: pr, ...data } = parsed.data;
    return {
      kind: 'pull_request',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      prNumber: pr.number,
      action: data.action,
      updatedAt: pr.updated_at,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headRepositoryId: pr.head.repo?.id ?? null,
      baseRepositoryId: pr.base.repo?.id ?? null,
      before: data.before,
      closed: pr.state === 'closed',
      merged: pr.merged === true,
      ...(pr.title !== undefined
        ? {
            purpose: {
              title: truncateWatchPrBody(pr.title, 500),
              body: truncateWatchPrBody(pr.body ?? null, 8000),
            },
          }
        : {}),
    };
  }
  if (eventType === 'pull_request_review_comment') {
    const parsed = commentPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    const content = watchPrFeedbackContent(data.comment.body, data.comment.user.login);
    return {
      kind: 'feedback',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      prNumber: data.pull_request.number,
      key: `comment:${data.comment.id}`,
      action: data.action,
      updatedAt: data.comment.updated_at,
      sha: data.comment.commit_id,
      actorId: data.comment.user.id,
      actorLogin: data.comment.user.login,
      actorType: data.comment.user.type,
      authorAssociation: data.comment.author_association,
      source: 'review_comment',
      sourceId: data.comment.id,
      rootId: data.comment.in_reply_to_id ?? data.comment.id,
      url: data.comment.html_url,
      body: truncateWatchPrBody(content),
      contentFingerprint: watchPrContentFingerprint(content),
      bodyTruncated: content.length > 12_000,
      state: 'commented',
    };
  }
  if (eventType === 'issue_comment') {
    const parsed = issueCommentPayload.safeParse(payload);
    if (!parsed.success) return null;
    const { comment, issue, installation, repository, action } = parsed.data;
    const content = watchPrFeedbackContent(comment.body, comment.user.login);
    return {
      kind: 'feedback',
      installationId: installation.id,
      repositoryId: repository.id,
      prNumber: issue.number,
      key: `issue_comment:${comment.id}`,
      action,
      updatedAt: comment.updated_at,
      sha: '0'.repeat(40),
      actorId: comment.user.id,
      actorLogin: comment.user.login,
      actorType: comment.user.type,
      authorAssociation: comment.author_association,
      source: 'conversation_comment',
      sourceId: comment.id,
      url: comment.html_url,
      body: truncateWatchPrBody(content),
      contentFingerprint: watchPrContentFingerprint(content),
      bodyTruncated: content.length > 12_000,
      state: 'commented',
    };
  }
  if (eventType === 'pull_request_review_thread') {
    const parsed = threadPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    return {
      kind: 'thread',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      prNumber: data.pull_request.number,
      threadId: data.thread.node_id,
      rootIds: [
        ...new Set(data.thread.comments.map(comment => comment.in_reply_to_id ?? comment.id)),
      ],
      resolved: data.action === 'resolved',
      updatedAt: data.thread.updated_at ?? null,
    };
  }
  if (eventType === 'pull_request_review') {
    const parsed = reviewPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    const content = watchPrFeedbackContent(data.review.body, data.review.user.login);
    return {
      kind: 'feedback',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      prNumber: data.pull_request.number,
      key: `review:${data.review.id}`,
      action: data.action,
      updatedAt:
        data.review.updated_at ?? (data.action === 'submitted' ? data.review.submitted_at : null),
      sha: data.review.commit_id,
      actorId: data.review.user.id,
      actorLogin: data.review.user.login,
      actorType: data.review.user.type,
      authorAssociation: data.review.author_association,
      source: 'review',
      sourceId: data.review.id,
      url: data.review.html_url,
      body: truncateWatchPrBody(content),
      contentFingerprint: watchPrContentFingerprint(content),
      bodyTruncated: content.length > 12_000,
      state: data.review.state.toLowerCase(),
      reviewAction: data.review.submitted_at ? data.action : undefined,
    };
  }
  if (eventType === 'check_run') {
    const parsed = checkPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    const run = data.check_run;
    return {
      kind: 'check',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      prNumbers: run.pull_requests.map(pr => pr.number),
      key: `check:${run.app.id}:${run.check_suite ? `suite:${run.check_suite.id}` : `run:${run.id}`}:${run.name}:${run.head_sha}`,
      objectId: run.id,
      name: run.name,
      detailsUrl: run.details_url,
      sha: run.head_sha,
      updatedAt: run.completed_at ?? run.started_at,
      startedAt: run.started_at,
      attempt: run.run_attempt ?? 1,
      state: run.status,
      conclusion: run.conclusion,
    };
  }
  if (eventType === 'status') {
    const parsed = statusPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
    return {
      kind: 'status',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      key: `status:${data.creator?.id ?? 'unknown'}:${data.context}:${data.sha}`,
      objectId: data.id,
      name: data.context,
      detailsUrl: data.target_url,
      sha: data.sha,
      updatedAt: data.updated_at,
      state: data.state,
    };
  }
  if (eventType === 'push') {
    const parsed = pushPayload.safeParse(payload);
    if (!parsed.success || !parsed.data.ref.startsWith('refs/heads/')) return null;
    const data = parsed.data;
    return {
      kind: 'push',
      installationId: data.installation.id,
      repositoryId: data.repository.id,
      ref: data.ref.slice('refs/heads/'.length),
      before: data.before,
      after: data.after,
      deleted: data.deleted,
      ...pushFiles(payload),
    };
  }
  return null;
}

function pushFiles(payload: unknown): { changedFiles: string[]; filesComplete: boolean } {
  const parsed = z
    .object({
      size: z.number().optional(),
      commits: z
        .array(
          z.object({
            added: z.array(z.string().max(1000)),
            modified: z.array(z.string().max(1000)),
            removed: z.array(z.string().max(1000)),
          })
        )
        .max(2048),
    })
    .safeParse(payload);
  if (!parsed.success) return { changedFiles: [], filesComplete: false };
  const files = [
    ...new Set(
      parsed.data.commits.flatMap(commit => [
        ...commit.added,
        ...commit.modified,
        ...commit.removed,
      ])
    ),
  ];
  return {
    changedFiles: files.slice(0, 3000),
    filesComplete:
      files.length <= 3000 &&
      parsed.data.commits.length < 2048 &&
      (parsed.data.size === undefined || parsed.data.size <= parsed.data.commits.length),
  };
}

export function isTrustedWatchPrFeedback(
  event: { actorLogin?: string; actorType?: string; authorAssociation?: string },
  policy?: WatchPrPolicy
): boolean {
  const login = event.actorLogin?.toLowerCase();
  const bots: readonly string[] =
    policy?.version === 2 ? policy.trustedBotLogins : watchPrDefaultTrustedBotLogins;
  if (login && event.actorType === 'Bot' && bots.includes(login)) return true;
  return (
    event.actorType !== 'Bot' &&
    ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(event.authorAssociation ?? '')
  );
}

const evidenceSchema = z.object({
  key: z.string().max(1200),
  kind: z.enum(['feedback', 'check', 'status', 'base']),
  sha: sha,
  updatedAt: timestamp.nullable(),
  objectId: id.optional(),
  startedAt: timestamp.nullable().optional(),
  attempt: z.number().int().positive().optional(),
  state: z.string().max(100),
  conclusion: z.string().max(100).nullable().optional(),
  actorId: id.optional(),
  body: z.string().max(12_000).optional(),
  bodyTruncated: z.boolean().optional(),
  removed: z.boolean().optional(),
  reviewAction: z.enum(['submitted', 'edited', 'dismissed']).optional(),
  actorLogin: z.string().max(100).optional(),
  trusted: z.boolean().optional(),
  contentFingerprint: z.string().max(128).optional(),
  source: z.enum(['review_comment', 'review', 'conversation_comment']).optional(),
  sourceId: z.string().max(200).optional(),
  rootId: z.string().max(200).optional(),
  threadId: z.string().max(200).optional(),
  url: z.string().url().max(2000).optional(),
  name: z.string().max(512).optional(),
  detailsUrl: z.string().url().max(2000).nullable().optional(),
});
const pendingSchema = z.object({
  key: z.string().max(1200),
  reason: z.enum([
    'reviewer_verification_required',
    'review_blocker',
    'failed_check',
    'failed_status',
    'base_changed',
    'actionable_review',
    'conflict',
  ]),
});
export const watchPrProjectionSchema = z.object({
  version: z.literal(1),
  evidence: z.array(evidenceSchema).max(100),
  pending: z.array(pendingSchema).max(100),
  ambiguous: z.boolean(),
  needsAttention: z.boolean(),
  truncated: z.boolean(),
  prUpdatedAt: timestamp.nullable(),
  prState: z.enum(['open', 'closed', 'merged']).nullable().default(null),
  headPushObserved: z.boolean(),
  basePushObserved: z.boolean(),
  purpose: z.object({ title: z.string().max(500), body: z.string().max(8000) }).optional(),
  threads: z
    .array(
      z.object({
        id: z.string().max(200),
        rootIds: z.array(z.string().max(200)).max(100),
        resolved: z.boolean(),
        updatedAt: timestamp.nullable(),
      })
    )
    .max(100)
    .default([]),
  files: z
    .object({ headSha: sha, paths: z.array(z.string().max(1000)).max(3000), complete: z.boolean() })
    .optional(),
  conflict: z
    .object({
      headSha: sha,
      baseSha: sha,
      state: z.enum(['CONFLICTING', 'MERGEABLE', 'UNKNOWN']),
      checkedAt: timestamp.nullable(),
      dueAt: timestamp.nullable(),
      retries: z.number().int().min(0).max(1),
    })
    .optional(),
});
export type WatchPrProjection = z.infer<typeof watchPrProjectionSchema>;
type Evidence = z.infer<typeof evidenceSchema>;

export function boundWatchPrPending(projection: WatchPrProjection) {
  if (projection.pending.length > 100) {
    projection.pending = projection.pending.slice(-100);
    projection.truncated = true;
  }
}

export function emptyWatchPrProjection(prUpdatedAt?: string): WatchPrProjection {
  return {
    version: 1,
    evidence: [],
    pending: [],
    ambiguous: false,
    needsAttention: false,
    truncated: false,
    prUpdatedAt: prUpdatedAt ? timestamp.parse(prUpdatedAt) : null,
    prState: prUpdatedAt ? 'open' : null,
    headPushObserved: false,
    basePushObserved: false,
    threads: [],
  };
}

export type WatchPrObservationState = {
  installation_id: string;
  repository_id: string;
  pr_number: number;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  base_sha: string;
  status: 'watching' | 'paused' | 'finished';
  generation: number;
  pending_revision: number;
  projection: unknown;
  lifecycle_reason: string | null;
  policy?: WatchPrPolicy;
};

export function watchPrEventMatches(watch: WatchPrObservationState, event: WatchPrEvent): boolean {
  if (watch.installation_id !== event.installationId || watch.repository_id !== event.repositoryId)
    return false;
  if (event.kind === 'pull_request' || event.kind === 'feedback' || event.kind === 'thread')
    return watch.pr_number === event.prNumber;
  if (event.kind === 'push') return watch.head_ref === event.ref || watch.base_ref === event.ref;
  return (
    watch.head_sha === event.sha ||
    event.kind === 'status' ||
    event.prNumbers.length === 0 ||
    event.prNumbers.includes(watch.pr_number)
  );
}

function compareEvidence(next: Evidence, previous: Evidence): number | null {
  if (JSON.stringify(next) === JSON.stringify(previous)) return 0;
  if (next.kind === 'feedback' && !next.key.startsWith('review:')) {
    if (next.removed && !previous.removed) return 1;
    if (previous.removed && !next.removed) return -1;
    if (
      next.actorId === previous.actorId &&
      next.sha === previous.sha &&
      next.updatedAt === previous.updatedAt &&
      next.state === previous.state &&
      next.trusted === previous.trusted &&
      (next.contentFingerprint ?? watchPrContentFingerprint(next.body ?? '')) ===
        (previous.contentFingerprint ?? watchPrContentFingerprint(previous.body ?? ''))
    )
      return 0;
  }
  if (next.kind === 'feedback' && next.key.startsWith('review:')) {
    if (next.actorId !== previous.actorId || next.sha !== previous.sha) return null;
    if (
      (!next.reviewAction || !previous.reviewAction) &&
      JSON.stringify({
        key: next.key,
        sha: next.sha,
        updatedAt: next.updatedAt,
        state: next.state,
        actorId: next.actorId,
        actorLogin: next.actorLogin,
        trusted: next.trusted,
        body: next.body,
        removed: next.removed,
      }) ===
        JSON.stringify({
          key: previous.key,
          sha: previous.sha,
          updatedAt: previous.updatedAt,
          state: previous.state,
          actorId: previous.actorId,
          actorLogin: previous.actorLogin,
          trusted: previous.trusted,
          body: previous.body,
          removed: previous.removed,
        })
    )
      return 0;
    if (next.state === 'dismissed' && previous.state !== 'dismissed') return 1;
    if (previous.state === 'dismissed' && next.state !== 'dismissed') return -1;
    if (
      next.state === previous.state &&
      ['approved', 'changes_requested', 'commented', 'dismissed'].includes(next.state)
    ) {
      const precedingAction = next.state === 'dismissed' ? 'dismissed' : 'submitted';
      if (next.reviewAction === 'edited' && previous.reviewAction === precedingAction) return 1;
      if (next.reviewAction === precedingAction && previous.reviewAction === 'edited') return -1;
    }
  }
  if (next.kind === 'check') {
    if (next.objectId === previous.objectId) {
      if ((next.attempt ?? 1) !== (previous.attempt ?? 1))
        return (next.attempt ?? 1) - (previous.attempt ?? 1);
      if (next.startedAt && previous.startedAt) {
        const startedOrder = Date.parse(next.startedAt) - Date.parse(previous.startedAt);
        if (startedOrder !== 0) return startedOrder;
      }
      if (
        next.state === 'in_progress' &&
        ['queued', 'waiting', 'requested', 'pending'].includes(previous.state)
      )
        return 1;
      if (next.state === 'queued' && previous.state !== 'queued' && !next.startedAt) return null;
      if (next.state === 'completed' && previous.state !== 'completed') return 1;
      if (previous.state === 'completed' && next.state !== 'completed') return -1;
    } else {
      if (next.startedAt && previous.startedAt) {
        const startedOrder = Date.parse(next.startedAt) - Date.parse(previous.startedAt);
        if (startedOrder !== 0) return startedOrder;
      }
      if (next.updatedAt && previous.updatedAt && next.updatedAt !== previous.updatedAt)
        return Date.parse(next.updatedAt) - Date.parse(previous.updatedAt);
      return null;
    }
  }
  if (next.updatedAt && previous.updatedAt && next.updatedAt !== previous.updatedAt) {
    const updatedOrder = Date.parse(next.updatedAt) - Date.parse(previous.updatedAt);
    if (updatedOrder !== 0) return updatedOrder;
  }
  if (
    next.kind === 'status' &&
    next.objectId &&
    previous.objectId &&
    next.objectId !== previous.objectId
  ) {
    return BigInt(next.objectId) > BigInt(previous.objectId) ? 1 : -1;
  }
  return null;
}

export function projectWatchPrEvent(
  watch: WatchPrObservationState,
  event: WatchPrEvent,
  expectedGeneration: number,
  selfActorIds: readonly string[] = [],
  maintenanceReplyIds: readonly string[] = []
): WatchPrObservationState {
  if (
    watch.status === 'finished' ||
    watch.generation !== expectedGeneration ||
    !watchPrEventMatches(watch, event)
  )
    return watch;
  const projection = watchPrProjectionSchema.parse(watch.projection);
  const next = { ...watch, projection: { ...projection, evidence: [...projection.evidence] } };
  let evidence: Evidence | undefined;
  if (event.kind === 'pull_request') {
    const prState = event.closed ? (event.merged ? 'merged' : 'closed') : 'open';
    if (projection.prUpdatedAt && Date.parse(event.updatedAt) < Date.parse(projection.prUpdatedAt))
      return watch;
    if (
      event.headRepositoryId !== watch.repository_id ||
      event.baseRepositoryId !== watch.repository_id
    ) {
      next.projection.ambiguous = true;
    } else if (
      projection.headPushObserved &&
      event.headSha !== watch.head_sha &&
      event.before !== watch.head_sha
    ) {
      next.projection.ambiguous = true;
    } else if (
      projection.prUpdatedAt &&
      Date.parse(projection.prUpdatedAt) === Date.parse(event.updatedAt) &&
      (event.headSha !== watch.head_sha ||
        event.baseSha !== watch.base_sha ||
        event.headRef !== watch.head_ref ||
        event.baseRef !== watch.base_ref ||
        (projection.prState !== null && projection.prState !== prState))
    ) {
      next.projection.ambiguous = true;
    } else if (event.closed) {
      next.status = 'finished';
      next.generation += 1;
      next.lifecycle_reason = event.merged ? 'pr_merged' : 'pr_closed';
      next.projection.pending = [];
      next.projection.needsAttention = false;
      next.projection.prUpdatedAt = event.updatedAt;
      next.projection.prState = prState;
      return next;
    } else {
      const baseRefChanged = event.baseRef !== watch.base_ref;
      if (event.purpose) next.projection.purpose = event.purpose;
      next.head_sha = event.headSha;
      next.head_ref = event.headRef;
      next.base_ref = event.baseRef;
      if (baseRefChanged) {
        next.projection.files = undefined;
        next.projection.evidence = next.projection.evidence.filter(item => item.kind !== 'base');
      }
      if (!baseRefChanged && projection.basePushObserved && event.baseSha !== watch.base_sha) {
        next.projection.ambiguous = true;
      } else if (baseRefChanged || event.baseSha !== watch.base_sha) {
        evidence = {
          kind: 'base',
          key: 'base',
          sha: event.baseSha,
          updatedAt: event.updatedAt,
          state: 'changed',
        };
      }
      if (baseRefChanged || !projection.basePushObserved || event.baseSha === watch.base_sha) {
        next.base_sha = event.baseSha;
        next.projection.basePushObserved = false;
      }
      next.projection.headPushObserved = false;
      next.projection.prState = prState;
    }
    next.projection.prUpdatedAt = event.updatedAt;
  } else if (event.kind === 'push') {
    const head = watch.head_ref === event.ref;
    const current = head ? watch.head_sha : watch.base_sha;
    if (event.after === current && !event.deleted) return watch;
    if (event.before !== current) {
      next.projection.ambiguous = true;
    } else if (event.deleted) {
      if (watch.status !== 'paused') {
        next.status = 'paused';
        next.generation += 1;
        next.lifecycle_reason = head ? 'head_branch_deleted' : 'base_branch_deleted';
      }
      next.projection.needsAttention = true;
      return next;
    } else if (head) {
      next.head_sha = event.after;
      next.projection.headPushObserved = true;
    } else {
      next.base_sha = event.after;
      next.projection.basePushObserved = true;
      evidence = { kind: 'base', key: 'base', sha: event.after, updatedAt: null, state: 'changed' };
    }
  } else if (event.kind === 'thread') {
    const previous = projection.threads.find(thread => thread.id === event.threadId);
    if (
      previous?.updatedAt &&
      event.updatedAt &&
      Date.parse(event.updatedAt) < Date.parse(previous.updatedAt)
    )
      return watch;
    if (
      previous &&
      previous.resolved !== event.resolved &&
      (!previous.updatedAt || !event.updatedAt)
    ) {
      next.projection.ambiguous = true;
    }
    next.projection.threads = [
      ...projection.threads.filter(thread => thread.id !== event.threadId),
      {
        id: event.threadId,
        rootIds: event.rootIds,
        resolved: event.resolved,
        updatedAt: event.updatedAt,
      },
    ].slice(-100);
    next.projection.evidence = next.projection.evidence.map(item =>
      item.kind === 'feedback' &&
      (item.threadId === event.threadId ||
        event.rootIds.includes(item.rootId ?? item.sourceId ?? item.key.slice('comment:'.length)))
        ? { ...item, threadId: event.threadId }
        : item
    );
  } else if (event.kind === 'feedback') {
    if (
      maintenanceReplyIds.includes(event.key) ||
      ((watchPrDefaultTrustedBotLogins.some(login => login === event.actorLogin?.toLowerCase()) ||
        selfActorIds.includes(event.actorId)) &&
        hasWatchPrMaintenanceReplyMarker(event.body))
    )
      return watch;
    const trusted = isTrustedWatchPrFeedback(event, watch.policy);
    const removesKnownFeedback =
      ['deleted', 'dismissed'].includes(event.action) &&
      projection.evidence.some(item => item.key === event.key && item.trusted);
    if (watch.policy?.version === 2 && !trusted && !removesKnownFeedback) return watch;
    evidence = {
      kind: 'feedback',
      key: event.key,
      sha: event.sha,
      updatedAt: event.updatedAt,
      state: event.state,
      actorId: event.actorId,
      body: event.body,
      trusted,
      actorLogin: event.actorLogin,
      contentFingerprint: event.contentFingerprint ?? watchPrContentFingerprint(event.body),
      source: event.source,
      bodyTruncated: event.bodyTruncated,
      sourceId: event.sourceId,
      rootId: event.rootId,
      threadId: event.threadId,
      url: event.url,
      removed:
        event.action === 'deleted' ||
        event.action === 'dismissed' ||
        (event.key.startsWith('review:') && event.state === 'dismissed'),
      ...(event.reviewAction ? { reviewAction: event.reviewAction } : {}),
    };
    if (event.bodyTruncated && (watch.policy?.version !== 2 || watch.policy.categories.reviews))
      next.projection.truncated = true;
  } else if (event.kind === 'check') {
    evidence = {
      kind: 'check',
      key: event.key,
      sha: event.sha,
      updatedAt: event.updatedAt,
      objectId: event.objectId,
      startedAt: event.startedAt,
      attempt: event.attempt,
      state: event.state,
      conclusion: event.conclusion,
      name: event.name,
      detailsUrl: event.detailsUrl,
    };
  } else {
    evidence = {
      kind: 'status',
      key: event.key,
      sha: event.sha,
      updatedAt: event.updatedAt,
      objectId: event.objectId,
      state: event.state,
      name: event.name,
      detailsUrl: event.detailsUrl,
    };
  }
  if (evidence) {
    const parsedEvidence = evidenceSchema.parse(evidence);
    const previous = next.projection.evidence.find(
      item =>
        item.key === parsedEvidence.key ||
        (['check', 'status'].includes(parsedEvidence.kind) &&
          item.kind === parsedEvidence.kind &&
          item.sha === parsedEvidence.sha &&
          ((item.name && parsedEvidence.name && item.objectId === parsedEvidence.objectId) ||
            (item.kind === 'status' && item.name && item.name === parsedEvidence.name)))
    );
    const order =
      previous && parsedEvidence.kind !== 'base' ? compareEvidence(parsedEvidence, previous) : 1;
    if (order === null) next.projection.ambiguous = true;
    else if (order > 0 || parsedEvidence.kind === 'base') {
      next.projection.evidence = next.projection.evidence.filter(
        item => item.key !== parsedEvidence.key && item.key !== previous?.key
      );
      next.projection.evidence.push(parsedEvidence);
      if (next.projection.evidence.length > 100) {
        const priority = (item: Evidence) =>
          item.kind === 'feedback' || item.kind === 'base' || item.sha === next.head_sha ? 1 : 0;
        next.projection.evidence = next.projection.evidence
          .sort((a, b) => priority(a) - priority(b))
          .slice(-100);
        next.projection.truncated = true;
      }
    }
  }
  if (next.head_sha !== watch.head_sha) {
    next.projection.files = undefined;
    next.projection.conflict = undefined;
  }
  if (next.base_sha !== watch.base_sha) {
    const files = next.projection.files;
    const paths = new Set(files?.paths);
    const noOverlap =
      event.kind === 'push' &&
      event.filesComplete &&
      files?.complete &&
      files.headSha === next.head_sha &&
      !event.changedFiles?.some(path => paths.has(path));
    const priorConflict =
      projection.conflict?.headSha === next.head_sha ? projection.conflict : undefined;
    next.projection.conflict =
      noOverlap && priorConflict
        ? { ...priorConflict, baseSha: next.base_sha }
        : {
            headSha: next.head_sha,
            baseSha: next.base_sha,
            state: 'UNKNOWN',
            checkedAt: priorConflict?.checkedAt ?? null,
            dueAt: noOverlap ? null : new Date(Date.now() + 30_000).toISOString(),
            retries: 0,
          };
  }
  next.projection.pending = next.projection.evidence.flatMap<WatchPrProjection['pending'][number]>(
    item => {
      if (item.removed) return [];
      if (item.kind === 'base') if (watch.policy?.version === 2) return [];
      if (item.kind === 'base')
        return item.sha === next.base_sha
          ? [{ key: item.key, reason: 'base_changed' as const }]
          : [];
      if (item.kind === 'feedback') {
        const thread = next.projection.threads.find(
          thread =>
            thread.id === item.threadId ||
            thread.rootIds.includes(item.rootId ?? item.sourceId ?? '')
        );
        if (thread?.resolved) return [];
        if (watch.policy?.version === 2 && (!item.trusted || !watch.policy.categories.reviews))
          return [];
        if (item.body?.replace(/<!--[\s\S]*?-->/g, '').trim())
          return [
            {
              key: item.key,
              reason:
                watch.policy?.version === 2
                  ? ('actionable_review' as const)
                  : ('reviewer_verification_required' as const),
            },
          ];
        return item.state === 'changes_requested'
          ? [{ key: item.key, reason: 'review_blocker' as const }]
          : [];
      }
      if (item.sha !== next.head_sha) return [];
      if (watch.policy?.version === 2 && !watch.policy.categories.failedChecks) return [];
      if (
        item.kind === 'check' &&
        item.state === 'completed' &&
        [
          'failure',
          'timed_out',
          'action_required',
          'startup_failure',
          'cancelled',
          'stale',
        ].includes(item.conclusion ?? '')
      ) {
        return [{ key: item.key, reason: 'failed_check' as const }];
      }
      return item.kind === 'status' && ['failure', 'error'].includes(item.state)
        ? [{ key: item.key, reason: 'failed_status' as const }]
        : [];
    }
  );
  if (
    next.projection.conflict?.state === 'CONFLICTING' &&
    next.projection.conflict.headSha === next.head_sha &&
    next.projection.conflict.baseSha === next.base_sha &&
    (watch.policy?.version !== 2 || watch.policy.categories.conflicts)
  ) {
    next.projection.pending.push({ key: 'conflict', reason: 'conflict' });
  }
  boundWatchPrPending(next.projection);
  next.projection.needsAttention =
    next.projection.evidence.some(
      item =>
        item.bodyTruncated &&
        !item.removed &&
        (watch.policy?.version !== 2 || watch.policy.categories.reviews)
    ) ||
    next.projection.ambiguous ||
    next.projection.truncated ||
    (next.status === 'paused' &&
      ['head_branch_deleted', 'base_branch_deleted'].includes(next.lifecycle_reason ?? '')) ||
    next.projection.pending.some(item =>
      ['reviewer_verification_required', 'review_blocker'].includes(item.reason)
    );
  const pendingEvidence = (value: WatchPrProjection) =>
    value.pending
      .map(item => ({
        ...item,
        evidence: (() => {
          const evidence = value.evidence.find(observation => observation.key === item.key);
          return evidence?.kind === 'feedback'
            ? {
                key: evidence.key,
                removed: evidence.removed,
                state: evidence.state,
                contentFingerprint:
                  evidence.contentFingerprint ?? watchPrContentFingerprint(evidence.body ?? ''),
              }
            : evidence;
        })(),
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  if (
    JSON.stringify(pendingEvidence(next.projection)) !== JSON.stringify(pendingEvidence(projection))
  )
    next.pending_revision += 1;
  return JSON.stringify(next) === JSON.stringify({ ...watch, projection }) ? watch : next;
}
