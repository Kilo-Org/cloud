import { z } from 'zod';

const id = z
  .union([z.number().int().positive().safe(), z.string().regex(/^\d{1,20}$/)])
  .transform(String);
const sha = z
  .string()
  .regex(/^[a-f0-9]{40}$/i)
  .transform(value => value.toLowerCase());
const timestamp = z.string().datetime({ offset: true });
const ref = z.string().min(1).max(1024);
function truncateBody(value: string | null) {
  const withoutNulls = (value ?? '').replaceAll(String.fromCharCode(0), '');
  const truncated = withoutNulls.slice(0, 4000);
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
const body = z.string().nullable().transform(truncateBody);
const actor = z.object({ id, type: z.string().max(100).optional() });
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
  }),
});
const commentPayload = envelope.extend({
  action: z.enum(['created', 'edited', 'deleted']),
  pull_request: prIdentity,
  comment: z.object({ id, body, user: actor, updated_at: timestamp, commit_id: sha }),
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
  }),
});
const checkPayload = envelope.extend({
  action: z.string().max(100),
  check_run: z.object({
    id,
    head_sha: sha,
    name: z.string().min(1).max(512),
    app: z.object({ id }),
    check_suite: z.object({ id }).optional(),
    status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
    conclusion: z.string().max(100).nullable(),
    started_at: timestamp.nullable(),
    completed_at: timestamp.nullable(),
    run_attempt: z.number().int().positive().optional(),
    pull_requests: z.array(prIdentity).max(100).default([]),
  }),
});
const statusPayload = envelope.extend({
  id,
  sha,
  context: z.string().min(1).max(512),
  state: z.enum(['pending', 'success', 'failure', 'error']),
  updated_at: timestamp,
  creator: actor.optional(),
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
      }
    | {
        kind: 'feedback';
        prNumber: number;
        key: string;
        action: string;
        updatedAt: string | null;
        sha: string;
        actorId: string;
        body: string;
        state: string;
      }
    | WatchPrCiEvent
    | { kind: 'push'; ref: string; before: string; after: string; deleted: boolean }
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
    };
  }
  if (eventType === 'pull_request_review_comment') {
    const parsed = commentPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
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
      body: data.comment.body,
      state: 'commented',
    };
  }
  if (eventType === 'pull_request_review') {
    const parsed = reviewPayload.safeParse(payload);
    if (!parsed.success) return null;
    const data = parsed.data;
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
      body: data.review.body,
      state: data.review.state.toLowerCase(),
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
    };
  }
  return null;
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
  body: z.string().max(4000).optional(),
  removed: z.boolean().optional(),
});
const pendingSchema = z.object({
  key: z.string().max(1200),
  reason: z.enum([
    'reviewer_verification_required',
    'review_blocker',
    'failed_check',
    'failed_status',
    'base_changed',
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
});
export type WatchPrProjection = z.infer<typeof watchPrProjectionSchema>;
type Evidence = z.infer<typeof evidenceSchema>;

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
};

export function watchPrEventMatches(watch: WatchPrObservationState, event: WatchPrEvent): boolean {
  if (watch.installation_id !== event.installationId || watch.repository_id !== event.repositoryId)
    return false;
  if (event.kind === 'pull_request' || event.kind === 'feedback')
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
  if (next.kind === 'check') {
    if (next.objectId === previous.objectId) {
      if ((next.attempt ?? 1) !== (previous.attempt ?? 1))
        return (next.attempt ?? 1) - (previous.attempt ?? 1);
      if (next.startedAt && previous.startedAt) {
        const startedOrder = Date.parse(next.startedAt) - Date.parse(previous.startedAt);
        if (startedOrder !== 0) return startedOrder;
      }
      if (next.state === 'queued' && previous.state !== 'queued' && !next.startedAt) return null;
      if (next.state === 'completed' && previous.state !== 'completed') return 1;
      if (previous.state === 'completed' && next.state !== 'completed') return -1;
    } else {
      if (next.startedAt && previous.startedAt) {
        const startedOrder = Date.parse(next.startedAt) - Date.parse(previous.startedAt);
        if (startedOrder !== 0) return startedOrder;
      }
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
  selfActorIds: readonly string[] = []
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
      next.head_sha = event.headSha;
      next.head_ref = event.headRef;
      next.base_ref = event.baseRef;
      if (baseRefChanged) {
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
  } else if (event.kind === 'feedback') {
    if (selfActorIds.includes(event.actorId)) return watch;
    evidence = {
      kind: 'feedback',
      key: event.key,
      sha: event.sha,
      updatedAt: event.updatedAt,
      state: event.state,
      actorId: event.actorId,
      body: event.body,
      removed: event.action === 'deleted' || event.action === 'dismissed',
    };
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
    };
  } else {
    evidence = {
      kind: 'status',
      key: event.key,
      sha: event.sha,
      updatedAt: event.updatedAt,
      objectId: event.objectId,
      state: event.state,
    };
  }
  if (evidence) {
    const parsedEvidence = evidenceSchema.parse(evidence);
    const previous = next.projection.evidence.find(item => item.key === parsedEvidence.key);
    const order =
      previous && parsedEvidence.kind !== 'base' ? compareEvidence(parsedEvidence, previous) : 1;
    if (order === null) next.projection.ambiguous = true;
    else if (order > 0 || parsedEvidence.kind === 'base') {
      next.projection.evidence = next.projection.evidence.filter(
        item => item.key !== parsedEvidence.key
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
  next.projection.pending = next.projection.evidence.flatMap<WatchPrProjection['pending'][number]>(
    item => {
      if (item.removed) return [];
      if (item.kind === 'base')
        return item.sha === next.base_sha
          ? [{ key: item.key, reason: 'base_changed' as const }]
          : [];
      if (item.kind === 'feedback') {
        if (item.body?.trim())
          return [{ key: item.key, reason: 'reviewer_verification_required' as const }];
        return item.state === 'changes_requested'
          ? [{ key: item.key, reason: 'review_blocker' as const }]
          : [];
      }
      if (item.sha !== next.head_sha) return [];
      if (
        item.kind === 'check' &&
        item.state === 'completed' &&
        ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(
          item.conclusion ?? ''
        )
      ) {
        return [{ key: item.key, reason: 'failed_check' as const }];
      }
      return item.kind === 'status' && ['failure', 'error'].includes(item.state)
        ? [{ key: item.key, reason: 'failed_status' as const }]
        : [];
    }
  );
  next.projection.needsAttention =
    next.projection.ambiguous ||
    next.projection.truncated ||
    (next.status === 'paused' &&
      ['head_branch_deleted', 'base_branch_deleted'].includes(next.lifecycle_reason ?? '')) ||
    next.projection.pending.some(item =>
      ['reviewer_verification_required', 'review_blocker'].includes(item.reason)
    );
  const pendingEvidence = (value: WatchPrProjection) =>
    value.pending.map(item => ({
      ...item,
      evidence: value.evidence.find(observation => observation.key === item.key),
    }));
  if (
    JSON.stringify(pendingEvidence(next.projection)) !== JSON.stringify(pendingEvidence(projection))
  )
    next.pending_revision += 1;
  return JSON.stringify(next) === JSON.stringify({ ...watch, projection }) ? watch : next;
}
