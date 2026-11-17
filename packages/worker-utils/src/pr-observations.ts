import * as z from 'zod';

export const PR_OBSERVATION_LIMIT = 200;
const id = z
  .union([z.number().int().nonnegative(), z.string().max(20).regex(/^\d+$/)])
  .transform(String);
const text = z.string().min(1).max(512);
const sha = z
  .string()
  .regex(/^[a-f\d]{40}$/i)
  .transform(value => value.toLowerCase());
const timestamp = z.iso.datetime({ offset: true });
const checkOutcomeSchema = z.enum(['passed', 'failed', 'pending', 'skipped', 'unknown']);
const checkSchema = z.object({
  key: z.string().max(1050),
  id,
  attempt: z.number().int().positive(),
  at: timestamp.nullable(),
  phase: z.number().int().min(0).max(2),
  failed: z.boolean(),
  outcome: checkOutcomeSchema.optional(),
});
const threadSchema = z.object({
  rootId: id,
  threadId: text.nullable(),
  state: z.enum(['unresolved', 'resolved', 'unknown']),
});
const unavailableSchema = z.enum(['checks', 'statuses', 'reviews']);
export const prMergeabilitySchema = z.object({
  headSha: sha,
  baseSha: sha,
  baseRef: z.string().min(1).max(512),
  mergeable: z.boolean().nullable(),
  state: z.string().max(100).nullable(),
  observedAt: timestamp,
});
export type PrMergeability = z.infer<typeof prMergeabilitySchema>;
export const prObservationsSchema = z.object({
  version: z.literal(1),
  headSha: sha.nullable(),
  checks: z.array(checkSchema).max(PR_OBSERVATION_LIMIT),
  threads: z.array(threadSchema).max(PR_OBSERVATION_LIMIT),
  threadsObserved: z.boolean(),
  threadsUnknown: z.boolean(),
  checksTruncated: z.boolean(),
  threadsTruncated: z.boolean(),
  checksObserved: z.boolean().optional(),
  checksComplete: z.boolean().optional(),
  threadsComplete: z.boolean().optional(),
  unavailable: z.array(unavailableSchema).optional(),
  mergeability: prMergeabilitySchema.optional(),
});
export type PrObservations = z.infer<typeof prObservationsSchema>;
const summaryCheckSchema = z.object({
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative().optional(),
  pending: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  unknown: z.number().int().nonnegative().optional(),
  complete: z.boolean().optional(),
});
export const prObservationSummarySchema = z.object({
  checks: summaryCheckSchema.nullable(),
  unresolvedThreads: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  threadsComplete: z.boolean().optional(),
  mergeability: prMergeabilitySchema.nullable().optional(),
  unavailable: z.array(unavailableSchema).optional(),
});
export type PrObservationSummary = z.infer<typeof prObservationSummarySchema>;
const envelope = z.object({
  installation: z.object({ id }),
  repository: z.object({ id, full_name: text }),
});
const commentSchema = z.object({ id, in_reply_to_id: id.nullish() });
const checkPayloadSchema = envelope.extend({
  check_run: z.object({
    id,
    app: z.object({ id }),
    name: text,
    head_sha: sha,
    run_attempt: z.number().int().positive().optional(),
    status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']),
    conclusion: z.string().nullish(),
    started_at: timestamp.nullish(),
    completed_at: timestamp.nullish(),
  }),
});
const statusPayloadSchema = envelope.extend({
  id,
  sha,
  context: text,
  state: z.enum(['pending', 'success', 'failure', 'error']),
  updated_at: timestamp,
});
const commentPayloadSchema = envelope.extend({
  action: z.enum(['created', 'edited', 'deleted']),
  pull_request: z.object({ number: z.number().int().positive() }),
  comment: commentSchema,
});
const threadPayloadSchema = envelope.extend({
  action: z.enum(['resolved', 'unresolved']),
  pull_request: z.object({ number: z.number().int().positive() }),
  thread: z.object({ node_id: text, comments: z.array(commentSchema) }),
});
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]);
type EventIdentity = { installationId: string; repositoryId: string; repository: string };
export type PrObservationEvent = EventIdentity &
  (
    | { kind: 'check'; sha: string; check: z.infer<typeof checkSchema> }
    | {
        kind: 'thread';
        prNumber: number;
        rootId: string | null;
        threadId: string | null;
        state: 'unresolved' | 'resolved' | 'unknown';
        fromComment: boolean;
      }
  );

export function createEmptyPrObservations(): PrObservations {
  return {
    version: 1,
    headSha: null,
    checks: [],
    threads: [],
    threadsObserved: false,
    threadsUnknown: false,
    checksTruncated: false,
    threadsTruncated: false,
    checksObserved: false,
    checksComplete: false,
    threadsComplete: false,
    unavailable: [],
  };
}

function checkOutcome(check: {
  failed: boolean;
  phase: number;
  outcome?: z.infer<typeof checkOutcomeSchema>;
}): z.infer<typeof checkOutcomeSchema> {
  if (check.outcome) return check.outcome;
  if (check.failed) return 'failed';
  return check.phase >= 2 ? 'unknown' : 'pending';
}

function checkRunOutcome(
  status: string,
  conclusion: string | null
): z.infer<typeof checkOutcomeSchema> {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'neutral' || conclusion === 'skipped') return 'skipped';
  if (conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)) return 'failed';
  return 'unknown';
}

function commitStatusOutcome(state: 'pending' | 'success' | 'failure' | 'error') {
  if (state === 'success') return 'passed';
  if (state === 'pending') return 'pending';
  if (state === 'failure' || state === 'error') return 'failed';
  return 'unknown';
}

function eventIdentity(payload: z.infer<typeof envelope>): EventIdentity {
  return {
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repository: payload.repository.full_name,
  };
}

export function normalizePrObservationEvent(
  eventType: string,
  payload: unknown
): PrObservationEvent | null {
  if (eventType === 'check_run') {
    const parsed = checkPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    const run = parsed.data.check_run;
    const outcome = checkRunOutcome(run.status, run.conclusion ?? null);
    return {
      ...eventIdentity(parsed.data),
      kind: 'check',
      sha: run.head_sha,
      check: {
        key: `check:${run.app.id}:${run.name}`,
        id: run.id,
        attempt: run.run_attempt ?? 1,
        at: run.completed_at ?? run.started_at ?? null,
        phase: run.status === 'completed' ? 2 : run.status === 'in_progress' ? 1 : 0,
        failed: outcome === 'failed',
        outcome,
      },
    };
  }
  if (eventType === 'status') {
    const parsed = statusPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    const status = parsed.data;
    const outcome = commitStatusOutcome(status.state);
    return {
      ...eventIdentity(status),
      kind: 'check',
      sha: status.sha,
      check: {
        key: `status:${status.context}`,
        id: status.id,
        attempt: 1,
        at: status.updated_at,
        phase: status.state === 'pending' ? 0 : 2,
        failed: outcome === 'failed',
        outcome,
      },
    };
  }
  if (eventType === 'pull_request_review_comment') {
    const parsed = commentPayloadSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.action === 'edited' ||
      parsed.data.comment.in_reply_to_id != null
    )
      return null;
    return {
      ...eventIdentity(parsed.data),
      kind: 'thread',
      prNumber: parsed.data.pull_request.number,
      rootId: parsed.data.comment.id,
      threadId: null,
      state: parsed.data.action === 'deleted' ? 'unknown' : 'unresolved',
      fromComment: true,
    };
  }
  if (eventType === 'pull_request_review_thread') {
    const parsed = threadPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    const rootIds = new Set(
      parsed.data.thread.comments.map(comment => comment.in_reply_to_id ?? comment.id)
    );
    return {
      ...eventIdentity(parsed.data),
      kind: 'thread',
      prNumber: parsed.data.pull_request.number,
      rootId: rootIds.size === 1 ? [...rootIds][0] : null,
      threadId: parsed.data.thread.node_id,
      state: parsed.data.action,
      fromComment: false,
    };
  }
  return null;
}

export function reducePrObservation(
  raw: unknown,
  currentHeadSha: string | null,
  event: PrObservationEvent
): PrObservations | null {
  const parsed = prObservationsSchema.safeParse(raw);
  const state: PrObservations = parsed.success
    ? parsed.data
    : {
        ...createEmptyPrObservations(),
        threadsUnknown: raw != null,
        checksTruncated: raw != null,
        threadsTruncated: raw != null,
      };
  if (event.kind === 'check') {
    if (event.sha !== currentHeadSha?.toLowerCase()) return parsed.success ? state : null;
    if (state.headSha !== event.sha) {
      state.headSha = event.sha;
      state.checks = [];
      state.checksTruncated = false;
      state.checksObserved = false;
      state.checksComplete = false;
      if (state.mergeability?.headSha !== event.sha) state.mergeability = undefined;
    }
    const index = state.checks.findIndex(check => check.key === event.check.key);
    const old = state.checks[index];
    const next = { ...event.check };
    next.outcome ??= checkOutcome(next);
    next.failed = next.outcome === 'failed';
    if (old) {
      const nextId = BigInt(next.id);
      const oldId = BigInt(old.id);
      if (nextId < oldId || (nextId === oldId && next.attempt < old.attempt)) return state;
      if (nextId === oldId && next.attempt === old.attempt) {
        if (old.at && (!next.at || Date.parse(next.at) < Date.parse(old.at))) return state;
        if (next.at === old.at && next.phase < old.phase) return state;
        if (next.at === old.at && next.phase === old.phase) {
          next.failed ||= old.failed;
          if (old.failed || old.outcome === 'failed') {
            next.failed = true;
            next.outcome = 'failed';
          }
        }
      }
      state.checks[index] = next;
    } else if (state.checks.length < PR_OBSERVATION_LIMIT) state.checks.push(next);
    else state.checksTruncated = true;
    return state;
  }
  state.threadsObserved = true;
  const old = state.threads.find(
    thread =>
      thread.rootId === event.rootId ||
      (event.threadId !== null && thread.threadId === event.threadId)
  );
  if (!event.rootId && !old) {
    state.threadsUnknown = true;
    return state;
  }
  if (old) {
    if (event.fromComment) {
      if (event.state === 'unknown') {
        old.state = 'unknown';
        state.threadsTruncated = true;
      }
      return state;
    }
    if (event.threadId) old.threadId = event.threadId;
    // GitHub supplies no resolution revision; this cache reflects the last received action.
    old.state = event.state;
  } else if (event.rootId) {
    if (state.threads.length < PR_OBSERVATION_LIMIT)
      state.threads.push({ rootId: event.rootId, threadId: event.threadId, state: event.state });
    else state.threadsTruncated = true;
  }
  return state;
}

export function getPrObservationSummary(
  raw: unknown,
  currentHeadSha: string | null
): PrObservationSummary | null {
  const parsed = prObservationsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const state = parsed.data;
  const headMatches = state.headSha === currentHeadSha?.toLowerCase();
  const checksUnavailable =
    state.unavailable?.includes('checks') || state.unavailable?.includes('statuses');
  const reviewsUnavailable = state.unavailable?.includes('reviews');
  const checksObserved = headMatches && (state.checksObserved === true || state.checks.length > 0);
  let checks: PrObservationSummary['checks'] = null;
  if (checksObserved) {
    const counts = {
      total: state.checks.length,
      failed: 0,
      passed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
    };
    for (const check of state.checks) {
      const outcome = checkOutcome(check);
      if (outcome === 'failed') counts.failed += 1;
      else if (outcome === 'passed') counts.passed += 1;
      else if (outcome === 'pending') counts.pending += 1;
      else if (outcome === 'skipped') counts.skipped += 1;
      else counts.unknown += 1;
    }
    checks = {
      ...counts,
      complete: state.checksComplete === true && !state.checksTruncated && !checksUnavailable,
    };
  }
  const mergeability =
    state.mergeability === undefined
      ? undefined
      : state.mergeability.headSha === currentHeadSha?.toLowerCase()
        ? state.mergeability
        : null;
  if (checks === null && !state.threadsObserved && !mergeability && !state.unavailable?.length)
    return null;
  const unknownThreads =
    state.threadsUnknown || state.threads.some(thread => thread.state === 'unknown');
  const summary: PrObservationSummary = {
    checks,
    unresolvedThreads:
      state.threadsObserved && !unknownThreads
        ? state.threads.filter(thread => thread.state === 'unresolved').length
        : null,
    truncated:
      (headMatches && state.checksTruncated) ||
      state.threadsTruncated ||
      unknownThreads ||
      (state.unavailable?.length ?? 0) > 0,
  };
  if (state.threadsObserved)
    summary.threadsComplete =
      state.threadsComplete === true &&
      !unknownThreads &&
      !state.threadsTruncated &&
      !reviewsUnavailable;
  if (mergeability !== undefined) summary.mergeability = mergeability;
  if (state.unavailable && state.unavailable.length > 0) summary.unavailable = state.unavailable;
  return summary;
}
