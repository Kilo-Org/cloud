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
const checkSchema = z.object({
  key: z.string().max(1050),
  id,
  attempt: z.number().int().positive(),
  at: timestamp.nullable(),
  phase: z.number().int().min(0).max(2),
  failed: z.boolean(),
});
const threadSchema = z.object({
  rootId: id,
  threadId: text.nullable(),
  state: z.enum(['unresolved', 'resolved', 'unknown']),
});
export const prObservationsSchema = z.object({
  version: z.literal(1),
  headSha: sha.nullable(),
  checks: z.array(checkSchema).max(PR_OBSERVATION_LIMIT),
  threads: z.array(threadSchema).max(PR_OBSERVATION_LIMIT),
  threadsObserved: z.boolean(),
  threadsUnknown: z.boolean(),
  checksTruncated: z.boolean(),
  threadsTruncated: z.boolean(),
});
export const prObservationSummarySchema = z.object({
  checks: z
    .object({ total: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
    .nullable(),
  unresolvedThreads: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
export type PrObservationSummary = z.infer<typeof prObservationSummarySchema>;
type PrObservations = z.infer<typeof prObservationsSchema>;
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
        failed:
          run.status === 'completed' &&
          [
            'failure',
            'cancelled',
            'timed_out',
            'action_required',
            'stale',
            'startup_failure',
          ].includes(run.conclusion ?? ''),
      },
    };
  }
  if (eventType === 'status') {
    const parsed = statusPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    const status = parsed.data;
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
        failed: status.state === 'failure' || status.state === 'error',
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
        version: 1,
        headSha: null,
        checks: [],
        threads: [],
        threadsObserved: false,
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
    }
    const index = state.checks.findIndex(check => check.key === event.check.key);
    const old = state.checks[index];
    const next = { ...event.check };
    if (old) {
      const nextId = BigInt(next.id);
      const oldId = BigInt(old.id);
      if (nextId < oldId || (nextId === oldId && next.attempt < old.attempt)) return state;
      if (nextId === oldId && next.attempt === old.attempt) {
        if (old.at && (!next.at || Date.parse(next.at) < Date.parse(old.at))) return state;
        if (next.at === old.at && next.phase < old.phase) return state;
        if (next.at === old.at && next.phase === old.phase) next.failed ||= old.failed;
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
    if (old.threadId !== null && old.state !== event.state) {
      old.state = 'unknown';
      state.threadsTruncated = true;
    }
    if (event.threadId) old.threadId = event.threadId;
    if (old.state !== 'unknown') old.state = event.state;
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
  const checks =
    state.headSha === currentHeadSha?.toLowerCase() && state.checks.length > 0
      ? { total: state.checks.length, failed: state.checks.filter(check => check.failed).length }
      : null;
  if (checks === null && !state.threadsObserved) return null;
  const unknownThreads =
    state.threadsUnknown || state.threads.some(thread => thread.state === 'unknown');
  return {
    checks,
    unresolvedThreads:
      state.threadsObserved && !unknownThreads
        ? state.threads.filter(thread => thread.state === 'unresolved').length
        : null,
    truncated:
      (state.headSha === currentHeadSha?.toLowerCase() && state.checksTruncated) ||
      state.threadsTruncated ||
      unknownThreads,
  };
}
