import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';
import { toolModelMessageSchema, type LanguageModel } from 'ai';
import { validQuestionResponse } from '@kilocode/agent-harness/tools';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import {
  type InteractionSchema,
  MessageSchema,
  RunSchema,
  type Conversation,
  type EventEnvelope,
  type Run,
  type ToolCall,
  type ToolOutcome,
} from '@kilocode/agent-harness/contracts';
import type { DispatchPolicy } from '@kilocode/agent-harness/policy';
import { bridgeWaitReason } from '@kilocode/agent-harness/bridge';
import { ExecutionGrantSchema, type ExecutionGrant } from '@kilocode/agent-harness/contracts';
import {
  clientAction,
  clientToolCommand,
  readClientGrant,
  rejectClientCommand,
  supportsClientCall,
  type ClientToolAuthorizer,
} from './client-tools';
import { commitDispatch, toolResultMessage } from './dispatch';
import {
  closeInteraction,
  waitForInteraction,
  resolveInteractionCommand,
  type InteractionAuthorizer,
} from './interactions';
import { compareAndSetCall, insertCall, insertCheckpoint, type StoreDatabase } from './db/records';
import type { ConversationStore } from './db/store';
import { StoreError, type AlarmStorage } from './db/wake';
import { HistoryProgressSchema, type HistoryProgress } from './legacy';
import * as s from './db/sqlite-schema';
import {
  PartialStepSchema,
  CompleteStepSchema,
  buildHistory,
  executorFreeTools,
  jsonValue,
  readCompleteStep,
  runModelStep,
  validateOutcome,
  validateStoredCall,
  type CompleteStep,
  type ModelTool,
  type TokenCounter,
} from './model-step';
import {
  ReservationSchema,
  RuntimeError,
  admissionForRun,
  fail,
  finishReservation,
  reserve,
  type Admission,
  type Reservation,
  type RunLimits,
} from './limits';

// Step zero is a non-executable scheduler record. Executable model steps start at one.
// Keep epochs and reservations in SQLite, not an instance field or a client connection.
export const SchedulerStateSchema = z.strictObject({
  kind: z.literal('scheduler'),
  epoch: z.int().nonnegative(),
  currentReservationId: z.uuid().nullable(),
  stopped: z.boolean(),
  reservations: z.array(ReservationSchema),
  // A12 records reconstruct SDK results from calls. Keep this fallback until those records retire.
  resultMessages: z.record(z.uuid(), toolModelMessageSchema).default({}),
  // Pre-sync checkpoints lack this record. Preserve their admission boundary once inference started.
  // Remove the fallback only after those checkpoints retire.
  initialHistory: z
    .discriminatedUnion('status', [
      z.strictObject({ status: z.literal('pending'), retryAt: z.int().nonnegative() }),
      z.strictObject({ status: z.literal('ready'), legacyThrough: z.int().nonnegative() }),
    ])
    .nullable()
    .default(null),
});
type SchedulerState = z.infer<typeof SchedulerStateSchema>;
type SchedulerRecord = { id: string; data: SchedulerState };
type Job = {
  run: Run;
  conversation: Conversation;
  admission: Admission;
  epoch: number;
  reservation: Reservation;
} & (
  | {
      kind: 'model';
      checkpointId: string;
      display: z.infer<typeof PartialStepSchema>;
      history: ReturnType<typeof buildHistory>;
    }
  | {
      kind: 'tool';
      call: ToolCall;
      reconciliation?: { attemptId: string; providerReference: string | null };
    }
);

type ToolExecution = {
  conversation: Conversation;
  run: Run;
  call: ToolCall;
  attemptId: string;
  signal: AbortSignal;
  limits: RunLimits;
};

export type SchedulerAdapter = {
  definitions: readonly ModelTool[];
  // The gateway adapter supplies a trusted upper bound for this exact model, including tool schemas.
  countTokens: TokenCounter;
  // Resolve the fixed model AND variant. No fallback or client bearer belongs in this adapter.
  model: (run: Run) => LanguageModel;
  authorize: (conversation: Conversation, run: Run, signal: AbortSignal) => Promise<void>;
  policy: (
    conversation: Conversation,
    run: Run,
    call: ToolCall,
    signal: AbortSignal
  ) => Promise<DispatchPolicy>;
  dispatch: (input: ToolExecution) => Promise<unknown>;
  // List only pinned definitions whose adapter proves safe outcome lookup, never mutation replay.
  reconciliation?: {
    definitions: readonly Pick<ModelTool, 'name' | 'version'>[];
    read: (input: ToolExecution & { providerReference: string | null }) => Promise<unknown>;
  };
  system: string;
  // Existing SQLite-only callers have no ingress source. Once a drain starts, a missing adapter
  // must never bypass its persisted pending state. Production composition supplies this hook.
  drainLegacy?: (conversation: Conversation, signal: AbortSignal) => Promise<HistoryProgress>;
  now?: () => number;
};
function schedulerRecord(db: StoreDatabase, runId: string): SchedulerRecord {
  const row = db
    .select()
    .from(s.checkpoints)
    .where(and(eq(s.checkpoints.runId, runId), eq(s.checkpoints.step, 0)))
    .get();
  return row
    ? { id: row.id, data: SchedulerStateSchema.parse(row.data) }
    : {
        id: crypto.randomUUID(),
        data: {
          kind: 'scheduler',
          epoch: 0,
          currentReservationId: null,
          stopped: false,
          reservations: [],
          resultMessages: {},
          initialHistory: null,
        },
      };
}
function writeScheduler(db: StoreDatabase, runId: string, record: SchedulerRecord) {
  const prior = db.select().from(s.checkpoints).where(eq(s.checkpoints.id, record.id)).get();
  const data = SchedulerStateSchema.parse({
    ...record.data,
    // Settlements inside this transition can add results after the caller reads its reservation.
    resultMessages: {
      ...(prior ? SchedulerStateSchema.parse(prior.data).resultMessages : {}),
      ...record.data.resultMessages,
    },
  });
  db.insert(s.checkpoints)
    .values({
      id: record.id,
      runId,
      step: 0,
      status: 'partial',
      data: jsonValue(data),
      definitionVersions: {},
    })
    .onConflictDoUpdate({ target: s.checkpoints.id, set: { data: jsonValue(data) } })
    .run();
}
function storedRun(db: StoreDatabase, runId: string) {
  const row = db.select().from(s.runs).where(eq(s.runs.id, runId)).get();
  if (!row) fail('invalid_input', 'The stored run is missing.');
  return RunSchema.parse(row.data);
}
function activeReservation(record: SchedulerRecord) {
  return record.data.reservations.find(item => item.id === record.data.currentReservationId);
}
function updateReservation(record: SchedulerRecord, reservation: Reservation) {
  record.data.reservations = record.data.reservations.map(item =>
    item.id === reservation.id ? reservation : item
  );
}
const runEvent = (run: Run, state: Run['state']): EventEnvelope['event'] => ({
  type: 'run',
  run: { ...run, state },
});
function displayMessage(
  run: Run,
  display: z.infer<typeof PartialStepSchema>,
  incomplete: boolean,
  parts?: CompleteStep['calls'][number]['call'][],
  citations: CompleteStep['citations'] = []
): EventEnvelope['event'] {
  return {
    type: 'message',
    message: MessageSchema.parse({
      id: display.messageId,
      role: 'assistant',
      content: display.text,
      createdAt: display.createdAt,
      clientId: null,
      provenance: 'harness',
      protocolVersion: 1,
      runId: run.id,
      incomplete,
      parts: [
        { type: 'text', text: display.text },
        ...citations,
        ...(parts ?? []).map(toolCall => ({ type: 'tool_call', toolCall })),
      ],
    }),
  };
}
function errorDetail(error: unknown) {
  if (error instanceof RuntimeError) return error.detail;
  return {
    code: 'invalid_output' as const,
    message: 'The model response was lost before its checkpoint.',
    retryable: !(error instanceof z.ZodError),
  };
}

async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createScheduler(
  state: DurableObjectState,
  store: ConversationStore,
  adapter: SchedulerAdapter,
  alarms: AlarmStorage & Pick<DurableObjectStorage, 'deleteAlarm'> = state.storage
) {
  const db = drizzle(state.storage),
    now = adapter.now ?? Date.now;
  let inFlight: { runId: string; controller: AbortController; abortable: boolean } | undefined;

  function nextDisplayTime() {
    const last = db
      .select({ createdAt: s.messages.createdAt })
      .from(s.messages)
      .orderBy(desc(s.messages.createdAt))
      .limit(1)
      .get();
    // Existing history and clients sort by timestamp, then ID. Reserve a stable display order.
    return new Date(Math.max(now(), last ? Date.parse(last.createdAt) + 1 : 0)).toISOString();
  }
  function current(job: Job, allowStopping = false, allowExpired = false) {
    const record = schedulerRecord(db, job.run.id),
      run = storedRun(db, job.run.id);
    return (
      record.data.epoch === job.epoch &&
      record.data.currentReservationId === job.reservation.id &&
      (allowExpired || now() < job.reservation.deadline) &&
      (run.state.status === 'running' || (allowStopping && run.state.status === 'stopping'))
    );
  }
  function fence(job: Job, allowStopping = false) {
    if (!current(job, allowStopping))
      fail('cancelled', 'This scheduler epoch no longer owns the work.');
  }
  function interrupt(runId: string) {
    // Admission records the named Stop first. A disconnected client cannot call this by aborting its request.
    if (
      inFlight?.runId === runId &&
      inFlight.abortable &&
      storedRun(db, runId).state.status === 'stopping'
    )
      inFlight.controller.abort(
        new RuntimeError({
          code: 'cancelled',
          message: 'The named run was stopped.',
          retryable: false,
        })
      );
  }
  async function maintainAlarm() {
    const error = await state.blockConcurrencyWhile(async () => {
      try {
        const snapshot = store.snapshot(),
          run = snapshot?.activeRun ?? snapshot?.queuedRuns[0];
        const record = run ? schedulerRecord(db, run.id) : undefined;
        const reservation = record && activeReservation(record);
        const ingress = record?.data.initialHistory;
        const projection = db
          .select({ dueAt: s.projectionWork.dueAt })
          .from(s.projectionWork)
          .where(isNull(s.projectionWork.acknowledgedAt))
          .orderBy(asc(s.projectionWork.dueAt))
          .limit(1)
          .get();
        const runnable = run && ['queued', 'running', 'stopping'].includes(run.state.status);
        const due = reservation
          ? reservation.deadline
          : runnable
            ? ingress?.status === 'pending' && run.state.status !== 'stopping'
              ? ingress.retryAt
              : now() + 1
            : null;
        const deadline = projection ? Math.min(due ?? Infinity, projection.dueAt) : due;
        // No other admission can pass the gate between the no-work/no-lease check and deletion.
        if (deadline === null) await alarms.deleteAlarm();
        else await alarms.setAlarm(deadline);
        return null;
      } catch {
        return new StoreError('storage_unavailable', true);
      }
    });
    if (error) throw error;
  }
  function callEvents(run: Run): EventEnvelope['event'][] {
    const calls = store.callsForRun(run.id);
    const rows = db
      .select()
      .from(s.checkpoints)
      .where(
        and(
          eq(s.checkpoints.runId, run.id),
          gt(s.checkpoints.step, 0),
          eq(s.checkpoints.status, 'complete')
        )
      )
      .all();
    const terminal =
      ['stopping', 'failed'].includes(run.state.status) || schedulerRecord(db, run.id).data.stopped;
    const limits = terminal ? null : admissionForRun(store, run).limits;
    return rows.flatMap(row => {
      const step = limits
        ? readCompleteStep(row.data, adapter.definitions, limits)
        : CompleteStepSchema.parse(row.data);
      return step.calls.flatMap((item, index) => {
        const stored = calls.find(call => call.id === item.call.id);
        if (!stored || stored.checkpointId !== row.id)
          fail('invalid_output', 'The checkpoint has no matching stored call.');
        const call = validateStoredCall(stored.data, item.call, adapter.definitions, limits);
        // A call owns its display message. Up to 32 bounded outputs must not form one oversized event.
        return [
          displayMessage(
            run,
            {
              ...step,
              kind: 'partial',
              messageId: call.id,
              createdAt: new Date(Date.parse(step.createdAt) + index + 1).toISOString(),
              text: '',
            },
            false,
            [call]
          ),
          ...(call.executionTarget.kind === 'client' && call.state === 'settled'
            ? [clientAction(call, null)]
            : []),
        ];
      });
    });
  }
  function settleCall(
    call: ReturnType<ConversationStore['callsForRun']>[number],
    result: ToolOutcome
  ) {
    const message = toolResultMessage(db, call.data, result);
    if (
      !compareAndSetCall(db, call.id, call.revision, {
        state: 'settled',
        approval: call.data.approval,
        result,
      })
    )
      throw new StoreError('command_conflict');
    const record = schedulerRecord(db, call.runId);
    record.data.resultMessages[call.id] = message;
    writeScheduler(db, call.runId, record);
  }
  function failPendingInteraction(
    run: Run,
    error: RuntimeError['detail']
  ): EventEnvelope['event'][] {
    if (error.retryable) return [];
    const interaction = store
      .snapshot()
      ?.unresolvedInteractions.find(
        item => item.kind === 'approval' && item.toolCall.runId === run.id
      );
    const call =
      interaction && store.callsForRun(run.id).find(item => item.id === interaction.toolCall.id);
    if (!call || call.data.state === 'executing') return [];
    const result: ToolOutcome = call.data.result ?? { status: 'failed', error };
    if (call.data.state !== 'settled') settleCall(call, result);
    return [
      ...closeInteraction(db, store, { ...call.data, state: 'settled', result }, 'approve'),
      ...callEvents({ ...run, state: { status: 'failed', error } }),
    ];
  }
  function unknownOutcome(
    run: Run,
    call: ToolCall,
    reason: string,
    providerReference?: string
  ): EventEnvelope['event'][] {
    // Keep the call executing until an adapter can confirm its outcome. Never retry an uncertain effect.
    const attempt = db
      .select()
      .from(s.attempts)
      .where(eq(s.attempts.toolCallId, call.id))
      .orderBy(asc(s.attempts.generation))
      .all()
      .at(-1);
    if (!attempt) fail('invalid_output', 'The current call has no durable dispatch attempt.');
    const reference = providerReference ?? attempt.providerReference;
    db.update(s.attempts)
      .set({
        outcome: {
          status: 'outcome_unknown',
          reason,
          ...(reference ? { providerReference: reference } : {}),
        },
        providerReference: reference,
      })
      .where(eq(s.attempts.id, attempt.id))
      .run();
    const display = {
      kind: 'partial' as const,
      attemptId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      createdAt: nextDisplayTime(),
      text: 'The current tool outcome is unknown. Reconciliation is required.',
    };
    return [
      displayMessage(run, display, false, [call]),
      ...(call.executionTarget.kind === 'client'
        ? [clientAction(call, 'reconciliation', readClientGrant(db, call)?.grant ?? null)]
        : []),
      runEvent(run, {
        status: 'waiting',
        waiting: { reason: 'reconciliation', toolCallId: call.id },
      }),
    ];
  }
  const needsReceipt = (call: ToolCall) =>
    call.effect !== 'read' || call.executionTarget.kind === 'client';
  function stopRun(run: Run, record: SchedulerRecord): EventEnvelope['event'][] {
    record.data.stopped = true;
    const reservation = activeReservation(record);
    const calls = store.callsForRun(run.id);
    const mutation = calls.find(call => call.data.state === 'executing' && needsReceipt(call.data));
    for (const call of calls) {
      if (call.data.state !== 'settled' && call.id !== mutation?.id)
        settleCall(call, { status: 'cancelled' });
    }
    const events = [
      ...store
        .callsForRun(run.id)
        .flatMap(call =>
          call.data.state === 'settled' ? closeInteraction(db, store, call.data, 'deny') : []
        ),
      ...callEvents(run),
    ];
    if (mutation && reservation && reservation.deadline > now()) {
      // Backend reads can abort. Mutations and client calls retain their lease for actual completion.
      writeScheduler(db, run.id, record);
      return events;
    }
    if (reservation) updateReservation(record, { ...reservation, status: 'interrupted' });
    record.data.epoch++;
    record.data.currentReservationId = null;
    writeScheduler(db, run.id, record);
    return [
      ...events,
      ...(mutation
        ? unknownOutcome(run, mutation.data, 'Stop cannot confirm the current mutation outcome.')
        : [runEvent(run, { status: 'cancelled' })]),
    ];
  }

  async function prepareInitialHistory() {
    const snapshot = store.snapshot();
    const selected = snapshot?.activeRun ?? snapshot?.queuedRuns[0];
    if (!selected || !snapshot || !['queued', 'running'].includes(selected.state.status))
      return true;
    const initial = schedulerRecord(db, selected.id).data.initialHistory;
    if (initial?.status === 'ready') return true;
    const drainLegacy = adapter.drainLegacy;
    if (!drainLegacy) return initial === null;
    if (initial?.status === 'pending' && initial.retryAt > now()) return false;
    const preparation: {
      ready: boolean;
      lease?: { run: Run; conversation: Conversation; epoch: number; deadline: number };
    } = { ready: false };
    await store.transition({ wakeAt: now() + 1 }, () => {
      const currentSnapshot = store.snapshot();
      const run = currentSnapshot?.activeRun ?? currentSnapshot?.queuedRuns[0];
      if (
        !run ||
        !currentSnapshot ||
        run.id !== selected.id ||
        !['queued', 'running'].includes(run.state.status)
      )
        return { events: [] };
      const record = schedulerRecord(db, run.id);
      if (record.data.initialHistory?.status === 'ready') {
        preparation.ready = true;
        return { events: [] };
      }
      if (
        record.data.initialHistory?.status === 'pending' &&
        record.data.initialHistory.retryAt > now()
      )
        return { events: [] };
      const started = db
        .select({ id: s.checkpoints.id })
        .from(s.checkpoints)
        .where(and(eq(s.checkpoints.runId, run.id), gt(s.checkpoints.step, 0)))
        .limit(1)
        .get();
      if (started && record.data.initialHistory === null) {
        // Earlier scheduler checkpoints already fixed their history at admission. Do not widen it.
        const input = db
          .select()
          .from(s.messages)
          .where(eq(s.messages.id, run.inputMessageId))
          .get();
        if (!input) fail('invalid_input', 'The accepted input message is missing.');
        record.data.initialHistory = { status: 'ready', legacyThrough: input.sequence - 1 };
        writeScheduler(db, run.id, record);
        preparation.ready = true;
        return { events: [] };
      }
      const deadline = now() + 30_000;
      record.data.epoch++;
      record.data.initialHistory = { status: 'pending', retryAt: deadline };
      writeScheduler(db, run.id, record);
      preparation.lease = {
        run,
        conversation: currentSnapshot.conversation,
        epoch: record.data.epoch,
        deadline,
      };
      return { events: [] };
    });
    const lease = preparation.lease;
    if (!lease) return preparation.ready;
    // Persist the continuation and arm recovery before external ingress. No model reservation starts here.
    await maintainAlarm();
    let progress: HistoryProgress | undefined;
    let failure: RuntimeError['detail'] | undefined;
    const signal = AbortSignal.timeout(Math.max(1, lease.deadline - now()));
    try {
      await abortable(signal, () => adapter.authorize(lease.conversation, lease.run, signal));
      const parsed = HistoryProgressSchema.safeParse(
        await abortable(signal, () => drainLegacy(lease.conversation, signal))
      );
      if (!parsed.success) fail('invalid_output', 'The legacy source returned invalid progress.');
      signal.throwIfAborted();
      if (now() >= lease.deadline)
        fail('storage_unavailable', 'Legacy ingress exceeded its deadline.', true);
      progress = parsed.data;
    } catch (error) {
      failure =
        error instanceof RuntimeError
          ? error.detail
          : {
              code: 'storage_unavailable',
              message: 'Legacy ingress is unavailable. Synchronization will retry.',
              retryable: true,
            };
    }
    await store.transition({ wakeAt: now() + 1 }, () => {
      const record = schedulerRecord(db, lease.run.id);
      const run = storedRun(db, lease.run.id);
      if (
        record.data.epoch !== lease.epoch ||
        record.data.initialHistory?.status !== 'pending' ||
        !['queued', 'running'].includes(run.state.status)
      )
        return { events: [] };
      record.data.epoch++;
      if (progress?.backlog === 'drained') {
        const cursor = store.snapshot()?.eventCursor;
        if (cursor === undefined) fail('invalid_input', 'The conversation is missing.');
        record.data.initialHistory = { status: 'ready', legacyThrough: cursor };
        preparation.ready = true;
      } else record.data.initialHistory = { status: 'pending', retryAt: now() + 1_000 };
      writeScheduler(db, run.id, record);
      return {
        events:
          failure && !failure.retryable
            ? [runEvent(run, { status: 'failed', error: failure })]
            : [],
      };
    });
    return preparation.ready;
  }

  async function claim(reconcile = false): Promise<Job | null> {
    const snapshot = store.snapshot();
    if (!snapshot || (!snapshot.activeRun && !snapshot.queuedRuns.length)) return null;
    if (!(await prepareInitialHistory())) {
      await maintainAlarm();
      return null;
    }
    let job: Job | null = null;
    // The existing wake gate prearms before any runnable write. maintainAlarm replaces this harmless
    // immediate recovery wake with the persisted lease deadline before awaited external work.
    await store.transition({ wakeAt: now() + 1 }, () => {
      const currentSnapshot = store.snapshot();
      const run = currentSnapshot?.activeRun ?? currentSnapshot?.queuedRuns[0];
      if (!run || !currentSnapshot) return { events: [] };
      const record = schedulerRecord(db, run.id),
        active = activeReservation(record);
      const reconciling =
        reconcile &&
        run.state.status === 'waiting' &&
        run.state.waiting.reason === 'reconciliation';
      if (reconcile && !reconciling) return { events: [] };
      if (run.state.status === 'stopping') return { events: stopRun(run, record) };
      if ((run.state.status === 'waiting' && !reconciling) || (active && active.deadline > now()))
        return { events: [] };
      if (record.data.initialHistory?.status === 'pending') return { events: [] };
      try {
        const admission = admissionForRun(store, run);
        if (active) {
          updateReservation(record, { ...active, status: 'interrupted' });
          record.data.currentReservationId = null;
          record.data.epoch++;
          writeScheduler(db, run.id, record);
        }
        const calls = store.callsForRun(run.id);
        const executing = calls.find(call => call.data.state === 'executing');
        const attempt =
          reconciling && executing
            ? db
                .select()
                .from(s.attempts)
                .where(eq(s.attempts.toolCallId, executing.id))
                .orderBy(desc(s.attempts.generation))
                .limit(1)
                .get()
            : undefined;
        if (
          reconciling &&
          (!executing ||
            executing.data.executionTarget.kind !== 'backend' ||
            !attempt ||
            !adapter.reconciliation?.definitions.some(
              item =>
                item.name === executing.data.name &&
                item.version === executing.data.definitionVersion
            ))
        )
          return { events: [] };
        if (executing && !reconciling) {
          if (needsReceipt(executing.data))
            return {
              events: unknownOutcome(run, executing.data, 'The dispatch response was lost.'),
            };
          settleCall(executing, {
            status: 'failed',
            error: {
              code: 'invalid_output',
              message: 'The interrupted read has no confirmed result.',
              retryable: true,
            },
          });
          return { events: callEvents(run) };
        }
        const pending = calls.find(call => call.data.state !== 'settled');
        const checkpointRows = db
          .select()
          .from(s.checkpoints)
          .where(and(eq(s.checkpoints.runId, run.id), gt(s.checkpoints.step, 0)))
          .orderBy(asc(s.checkpoints.step))
          .all();
        const last = checkpointRows.at(-1);
        // A run selected after the asynchronous drain must prepare its own initial boundary.
        // Older executable checkpoints still reconcile through their original admission history.
        if (adapter.drainLegacy && record.data.initialHistory === null && !last)
          return { events: [] };
        if (record.data.stopped && !reconciling) return { events: stopRun(run, record) };
        executorFreeTools(adapter.definitions);
        const step = pending
          ? checkpointRows.find(row => row.id === pending.checkpointId)?.step
          : last
            ? last.step + (last.status === 'complete' ? 1 : 0)
            : 1;
        if (!step) fail('invalid_output', 'The pending call has no executable checkpoint.');
        const history = pending
          ? null
          : buildHistory(
              db,
              store,
              run,
              adapter.definitions,
              admission.limits,
              adapter.countTokens,
              adapter.system,
              record.data.initialHistory?.status === 'ready'
                ? record.data.initialHistory.legacyThrough
                : undefined
            );
        const reservation = reserve(
          admission,
          record.data.reservations,
          pending
            ? {
                kind: 'tool',
                step,
                toolCallId: pending.id,
                webRequest:
                  !reconciling &&
                  adapter.definitions.find(item => item.name === pending.data.name)?.group ===
                    'web',
              }
            : { kind: 'model', step, inputTokens: history?.inputTokens ?? 0 },
          now()
        );
        record.data.epoch++;
        record.data.currentReservationId = reservation.id;
        record.data.reservations.push(reservation);
        writeScheduler(db, run.id, record);
        const common = {
          run: { ...run, state: { status: 'running' as const } },
          conversation: currentSnapshot.conversation,
          admission,
          epoch: record.data.epoch,
          reservation,
        };
        if (pending) {
          checkedCall(run, pending, admission);
          job = {
            ...common,
            kind: 'tool',
            call: pending.data,
            ...(attempt
              ? {
                  reconciliation: {
                    attemptId: attempt.id,
                    providerReference: attempt.providerReference,
                  },
                }
              : {}),
          };
        } else {
          if (!history) fail('invalid_input', 'Canonical history is unavailable.');
          const display = PartialStepSchema.parse({
            kind: 'partial',
            attemptId: reservation.id,
            messageId: crypto.randomUUID(),
            createdAt: nextDisplayTime(),
            text: '',
          });
          const checkpointId = last?.status !== 'complete' && last ? last.id : crypto.randomUUID();
          if (last?.status !== 'complete' && last)
            db.update(s.checkpoints)
              .set({ status: 'partial', data: display, definitionVersions: {} })
              .where(eq(s.checkpoints.id, last.id))
              .run();
          else
            insertCheckpoint(db, {
              id: checkpointId,
              runId: run.id,
              step,
              status: 'partial',
              data: display,
              definitionVersions: {},
            });
          job = { ...common, kind: 'model', checkpointId, display, history };
        }
        return { events: [runEvent(run, { status: 'running' })] };
      } catch (error) {
        if (error instanceof StoreError) throw error;
        job = null;
        const reservation = activeReservation(record);
        if (reservation) updateReservation(record, { ...reservation, status: 'interrupted' });
        record.data.epoch++;
        record.data.currentReservationId = null;
        writeScheduler(db, run.id, record);
        const uncertain =
          reconciling && store.callsForRun(run.id).find(call => call.data.state === 'executing');
        const detail = errorDetail(error);
        return {
          events: uncertain
            ? unknownOutcome(
                run,
                uncertain.data,
                'The safe outcome check could not complete within the stored limits.'
              )
            : [
                ...failPendingInteraction(run, detail),
                runEvent(run, { status: 'failed', error: detail }),
              ],
        };
      }
    });
    await maintainAlarm();
    return job;
  }
  async function appendPartial(job: Job & { kind: 'model' }, text: string) {
    await store.transition({ wakeAt: job.reservation.deadline }, () => {
      fence(job);
      const display = { ...job.display, text };
      db.update(s.checkpoints)
        .set({ data: display })
        .where(and(eq(s.checkpoints.id, job.checkpointId), eq(s.checkpoints.status, 'partial')))
        .run();
      return { events: [displayMessage(job.run, display, true)] };
    });
  }
  async function commitModel(job: Job & { kind: 'model' }, checkpoint: CompleteStep) {
    await store.transition({ wakeAt: now() + 1 }, () => {
      fence(job);
      const record = schedulerRecord(db, job.run.id);
      const existing = store.callsForRun(job.run.id);
      if (existing.length + checkpoint.calls.length > job.admission.limits.calls)
        fail('limit_exceeded', 'The run call limit is exhausted.');
      const versions = Object.fromEntries(
        checkpoint.calls.map(item => [item.call.name, item.call.definitionVersion])
      );
      const changed = db
        .update(s.checkpoints)
        .set({ status: 'complete', data: jsonValue(checkpoint), definitionVersions: versions })
        .where(and(eq(s.checkpoints.id, job.checkpointId), eq(s.checkpoints.status, 'partial')))
        .returning({ id: s.checkpoints.id })
        .get();
      if (!changed) throw new StoreError('command_conflict');
      for (const [index, item] of checkpoint.calls.entries())
        insertCall(db, item.call, {
          checkpointId: job.checkpointId,
          inputDigest: createHash('sha256')
            .update(canonicalizeValidatedInput(item.call.arguments))
            .digest('hex'),
          position: existing.length + index,
          policy: { permissionRevision: store.snapshot()?.conversation.permissionRevision },
        });
      updateReservation(record, finishReservation(job.reservation, now()));
      record.data.currentReservationId = null;
      writeScheduler(db, job.run.id, record);
      db.update(s.runs).set({ step: job.reservation.step }).where(eq(s.runs.id, job.run.id)).run();
      return {
        events: [
          displayMessage(
            job.run,
            { ...checkpoint, kind: 'partial' },
            false,
            undefined,
            checkpoint.citations
          ),
          ...callEvents(job.run),
          runEvent(job.run, { status: checkpoint.calls.length ? 'running' : 'completed' }),
        ],
      };
    });
  }
  async function finishFailure(job: Job, error: unknown) {
    if (error instanceof StoreError) throw error;
    if (!current(job, true, true)) return;
    await store.transition({ wakeAt: now() + 1 }, () => {
      if (!current(job, true, true)) return { events: [] };
      const record = schedulerRecord(db, job.run.id),
        run = storedRun(db, job.run.id);
      if (run.state.status === 'stopping') return { events: stopRun(run, record) };
      // An expired owner can record its failure, but never a successful checkpoint or effect.
      const detail =
        now() >= job.reservation.deadline
          ? {
              code: 'limit_exceeded' as const,
              message: 'The execution attempt exceeded its deadline.',
              retryable: false,
            }
          : errorDetail(error);
      updateReservation(record, finishReservation(job.reservation, now()));
      record.data.currentReservationId = null;
      writeScheduler(db, run.id, record);
      if (job.kind === 'model')
        db.update(s.checkpoints)
          .set({ status: 'failed' })
          .where(eq(s.checkpoints.id, job.checkpointId))
          .run();
      const call =
        job.kind === 'tool'
          ? store.callsForRun(run.id).find(item => item.id === job.call.id)
          : undefined;
      const failedCall =
        call &&
        (call.data.state === 'executing' || (call.data.approval !== null && !detail.retryable));
      if (failedCall) {
        if (call.data.state === 'executing' && needsReceipt(call.data))
          return {
            events: unknownOutcome(
              run,
              call.data,
              'The dispatch deadline passed without a confirmed outcome.'
            ),
          };
        const outcome: ToolOutcome = { status: 'failed', error: detail };
        settleCall(call, outcome);
        db.update(s.attempts)
          .set({ outcome: jsonValue(outcome) })
          .where(eq(s.attempts.id, job.reservation.id))
          .run();
      }
      const pendingEvents = failPendingInteraction(run, detail);
      return {
        events: [
          ...pendingEvents,
          ...(failedCall && !pendingEvents.length ? callEvents(run) : []),
          runEvent(
            run,
            detail.retryable ? { status: 'running' } : { status: 'failed', error: detail }
          ),
        ],
      };
    });
  }
  function dispatchCall(
    job: Job & { kind: 'tool' },
    policy: DispatchPolicy,
    grant?: ExecutionGrant,
    // Scheduler-only producers have no client report. Keep unavailable until a claim supplies readiness.
    reason: ReturnType<typeof bridgeWaitReason> = 'unavailable'
  ) {
    const call = store.callsForRun(job.run.id).find(item => item.id === job.call.id);
    const conversation = store.snapshot()?.conversation;
    if (!call || !conversation) fail('invalid_output', 'The stored dispatch call is missing.');
    validateStoredCall(call.data, job.call, adapter.definitions, job.admission.limits);
    const decision = commitDispatch(
      db,
      call,
      job.call,
      {
        ...policy,
        permissionMode: conversation.permissionMode,
        permissionRevision: conversation.permissionRevision,
        // Only durable answers and a designated grant release these gates, never adapter hints.
        questionAnswered: false,
        clientReady: grant !== undefined && reason === null,
      },
      job.reservation.id,
      job.epoch,
      grant
    );
    const result = (events: EventEnvelope['event'][]) => ({ decision, events });
    if (decision === 'dispatch')
      return result([
        ...closeInteraction(db, store, { ...call.data, state: 'executing' }, 'approve'),
        ...callEvents(job.run),
        ...(grant ? [clientAction(call.data, null), runEvent(job.run, { status: 'running' })] : []),
      ]);
    const record = schedulerRecord(db, job.run.id);
    // No effect occurred. Release this slot, but retain time spent checking authority.
    updateReservation(record, { ...finishReservation(job.reservation, now()), status: 'released' });
    record.data.currentReservationId = null;
    writeScheduler(db, job.run.id, record);
    if (decision === 'approval' || decision === 'question' || decision === 'client') {
      const waiting = { ...call.data, state: 'waiting' as const };
      if (!compareAndSetCall(db, call.id, call.revision, waiting))
        throw new StoreError('command_conflict');
      return result([
        ...(conversation.permissionMode === 'yolo'
          ? closeInteraction(db, store, waiting, 'approve')
          : []),
        ...(decision === 'client'
          ? [clientAction(waiting, reason ?? 'unavailable')]
          : [waitForInteraction(store, waiting, decision)]),
        ...(decision !== 'client' && call.data.executionTarget.kind === 'client'
          ? [clientAction(waiting, null)]
          : []),
        ...callEvents(job.run),
        runEvent(job.run, {
          status: 'waiting',
          waiting: { reason: decision, toolCallId: call.id },
        }),
      ]);
    }
    if (decision === 'stale_revision') return result([runEvent(job.run, { status: 'running' })]);
    if (decision === 'already_dispatched') return result([]);
    if (decision === 'denied') {
      settleCall(call, { status: 'denied' });
      return result(callEvents(job.run));
    }
    const error = {
      code:
        decision === 'access_revoked'
          ? ('access_revoked' as const)
          : decision === 'unavailable_tool'
            ? ('unavailable_tool' as const)
            : ('invalid_input' as const),
      message: 'The current dispatch authority does not permit this call.',
      retryable: false,
    };
    settleCall(call, { status: 'failed', error });
    const pendingEvents = failPendingInteraction(job.run, error);
    return result([
      ...(pendingEvents.length ? pendingEvents : callEvents(job.run)),
      runEvent(job.run, { status: 'failed', error }),
    ]);
  }
  async function executeTool(job: Job & { kind: 'tool' }, controller: AbortController) {
    const reconciliation = job.reconciliation;
    if (reconciliation) {
      const boundary = adapter.reconciliation;
      if (!boundary) fail('unavailable_tool', 'This adapter cannot confirm the stored outcome.');
      // Return the original operation outcome. Lookup failures must throw, not become mutation failures.
      const result = await abortable(controller.signal, () =>
        boundary.read({
          conversation: job.conversation,
          run: job.run,
          call: job.call,
          attemptId: reconciliation.attemptId,
          providerReference: reconciliation.providerReference,
          signal: controller.signal,
          limits: job.admission.limits,
        })
      );
      return commitToolOutcome(
        job,
        validateOutcome(result, job.call, adapter.definitions, job.admission.limits)
      );
    }
    const policy = await abortable(controller.signal, () =>
      adapter.policy(
        store.snapshot()?.conversation ?? job.conversation,
        job.run,
        job.call,
        controller.signal
      )
    );
    controller.signal.throwIfAborted();
    let dispatched = false,
      retryPolicy = false;
    await store.transition({ wakeAt: now() + 1 }, () => {
      fence(job);
      const result = dispatchCall(job, policy);
      dispatched = result.decision === 'dispatch';
      retryPolicy = result.decision === 'stale_revision';
      return { events: result.events };
    });
    if (!dispatched) return !retryPolicy;
    fence(job);
    let outcome: ToolOutcome;
    try {
      // This named backend boundary must recheck current account/context/resource authority before effects.
      // The execution identity is durable; adapters can use it only with proven provider guarantees.
      const result = await abortable(controller.signal, () =>
        adapter.dispatch({
          conversation: store.snapshot()?.conversation ?? job.conversation,
          run: job.run,
          call: job.call,
          attemptId: job.reservation.id,
          signal: controller.signal,
          limits: job.admission.limits,
        })
      );
      if (job.call.effect === 'read') controller.signal.throwIfAborted();
      outcome = validateOutcome(result, job.call, adapter.definitions, job.admission.limits);
    } catch (error) {
      if (error instanceof StoreError || controller.signal.aborted) throw error;
      outcome =
        job.call.effect === 'read'
          ? { status: 'failed', error: errorDetail(error) }
          : {
              status: 'outcome_unknown',
              reason: 'The mutation has no validated completion response.',
            };
    }
    return commitToolOutcome(job, outcome);
  }
  async function commitToolOutcome(job: Job & { kind: 'tool' }, outcome: ToolOutcome) {
    let committed = false;
    const attemptId = job.reconciliation?.attemptId ?? job.reservation.id;
    await store.transition({ wakeAt: now() + 1 }, () => {
      if (!current(job, true)) return { events: [] };
      committed = true;
      const record = schedulerRecord(db, job.run.id),
        run = storedRun(db, job.run.id);
      const call = store.callsForRun(run.id).find(item => item.id === job.call.id);
      if (!call) fail('invalid_output', 'The dispatched call is missing.');
      const stopping = run.state.status === 'stopping' || record.data.stopped;
      updateReservation(record, finishReservation(job.reservation, now()));
      record.data.currentReservationId = null;
      writeScheduler(db, run.id, record);
      return { events: settleToolOutcome(run, record, call, attemptId, outcome, stopping) };
    });
    return committed;
  }
  function settleToolOutcome(
    run: Run,
    record: SchedulerRecord,
    call: ReturnType<ConversationStore['callsForRun']>[number],
    attemptId: string,
    outcome: ToolOutcome,
    stopping: boolean
  ): EventEnvelope['event'][] {
    if (outcome.status === 'outcome_unknown') {
      if (outcome.providerReference)
        db.update(s.attempts)
          .set({ providerReference: outcome.providerReference })
          .where(eq(s.attempts.id, attemptId))
          .run();
      return stopping
        ? stopRun(run, record)
        : unknownOutcome(run, call.data, outcome.reason, outcome.providerReference);
    }
    db.update(s.attempts)
      .set({ outcome: jsonValue(outcome) })
      .where(eq(s.attempts.id, attemptId))
      .run();
    settleCall(call, outcome);
    return stopping
      ? stopRun(run, record)
      : [
          ...callEvents(run),
          ...(run.state.status === 'waiting' ? [runEvent(run, { status: 'running' })] : []),
        ];
  }
  function checkedCall(
    run: Run,
    call: ReturnType<ConversationStore['callsForRun']>[number],
    admission: Admission
  ) {
    const checkpoint = db
      .select()
      .from(s.checkpoints)
      .where(eq(s.checkpoints.id, call.checkpointId))
      .get();
    if (!checkpoint || checkpoint.status !== 'complete')
      fail('invalid_output', 'A partial cannot authorize dispatch.');
    const complete = readCompleteStep(checkpoint.data, adapter.definitions, admission.limits);
    const expected = complete.calls.find(item => item.call.id === call.id);
    if (
      !expected ||
      expected.call.runId !== run.id ||
      canonicalizeValidatedInput(expected.call.context) !==
        canonicalizeValidatedInput(store.snapshot()?.conversation.context) ||
      (expected.call.executionTarget.kind === 'client' &&
        expected.call.executionTarget.clientId !== run.originClientId)
    )
      fail('invalid_output', 'The call is absent from its scoped checkpoint.');
    validateStoredCall(call.data, expected.call, adapter.definitions, admission.limits);
    if (
      call.inputDigest !==
        createHash('sha256')
          .update(canonicalizeValidatedInput(call.data.arguments))
          .digest('hex') ||
      canonicalizeValidatedInput(
        store
          .callsForRun(run.id)
          .filter(item => item.checkpointId === checkpoint.id)
          .map(item => item.id)
      ) !== canonicalizeValidatedInput(complete.calls.map(item => item.call.id))
    )
      fail('invalid_output', 'The stored call digest or order has changed.');
    return checkpoint.step;
  }
  function releaseClientReservation(record: SchedulerRecord, call: ToolCall, interrupted: boolean) {
    const reservation = activeReservation(record);
    if (reservation?.toolCallId === call.id) {
      updateReservation(
        record,
        interrupted
          ? { ...reservation, status: 'interrupted' }
          : finishReservation(reservation, now())
      );
      record.data.currentReservationId = null;
    }
    record.data.epoch++;
    writeScheduler(db, call.runId, record);
  }
  function unavailableClientCall(
    run: Run,
    record: SchedulerRecord,
    call: ReturnType<ConversationStore['callsForRun']>[number],
    code: 'offline' | 'access_revoked' | 'storage_unavailable' | 'unavailable_tool'
  ): EventEnvelope['event'][] {
    if (call.data.state === 'settled') return [];
    if (run.state.status === 'stopping') record.data.stopped = true;
    releaseClientReservation(record, call.data, call.data.state === 'executing');
    if (record.data.stopped) return stopRun(run, record);
    if (call.data.state === 'executing')
      return unknownOutcome(
        run,
        call.data,
        `The designated client requires receipt reconciliation: ${code}.`
      );
    const waiting = { ...call.data, state: 'waiting' as const };
    if (!compareAndSetCall(db, call.id, call.revision, waiting))
      throw new StoreError('command_conflict');
    return [
      clientAction(waiting, code === 'offline' ? 'offline' : 'unavailable'),
      ...callEvents(run),
      runEvent(run, { status: 'waiting', waiting: { reason: 'client', toolCallId: call.id } }),
    ];
  }
  // Trusted registration/lifecycle notifications never authorize an effect or change its target.
  async function clientUnavailable(
    clientId: string,
    code: 'offline' | 'access_revoked' | 'storage_unavailable'
  ) {
    z.uuid().parse(clientId);
    await store.transition({ wakeAt: now() + 1 }, () => {
      const run = store.snapshot()?.activeRun;
      const call = run && store.callsForRun(run.id).find(item => item.data.state !== 'settled');
      if (
        !run ||
        !call ||
        call.data.executionTarget.kind !== 'client' ||
        call.data.executionTarget.clientId !== clientId
      )
        return { events: [] };
      return { events: unavailableClientCall(run, schedulerRecord(db, run.id), call, code) };
    });
    await maintainAlarm();
  }
  async function clientTool(input: unknown, authorize: ClientToolAuthorizer) {
    const preparation: { budget?: { runId: string; reservation: Reservation } } = {};
    const reply = await clientToolCommand(
      store,
      input,
      authorize,
      async (command, authority, replay) => {
        const row = db.select().from(s.calls).where(eq(s.calls.id, command.toolCallId)).get();
        if (!row) fail('invalid_input', 'The client call does not exist.');
        const run = storedRun(db, row.runId),
          admission = admissionForRun(store, run);
        const original = store.callsForRun(run.id).find(item => item.id === row.id);
        if (
          !original ||
          original.data.executionTarget.kind !== 'client' ||
          original.data.executionTarget.clientId !== authority.client.id
        )
          fail('access_revoked', 'Only the designated client can claim or complete this call.');
        // Validate persisted authority before the command journal can return a canonical replay.
        checkedCall(run, original, admission);
        if (!readClientGrant(db, original.data) && original.data.state === 'executing')
          fail('invalid_output', 'The executing client call has no grant.');
        let policy: DispatchPolicy | undefined;
        if (
          !replay &&
          command.type === 'claimClientTool' &&
          ['pending', 'waiting'].includes(original.data.state) &&
          authority.client.revokedAt === null &&
          authority.storageReady &&
          supportsClientCall(authority, original.data)
        ) {
          await store.transition({ wakeAt: now() + 1 }, () => {
            const currentRun = storedRun(db, run.id);
            const call = store.callsForRun(run.id).find(item => item.id === original.id);
            if (!call) fail('invalid_output', 'The stored client call is missing.');
            // Another claim can finish while this command enters the gate. Replay its grant below.
            if (call.data.state === 'executing' || call.data.state === 'settled')
              return { events: [] };
            if (
              store.snapshot()?.activeRun?.id !== run.id ||
              store.callsForRun(run.id).find(item => item.data.state !== 'settled')?.id !== call.id
            )
              fail('command_conflict', 'This call does not own the active run.', true);
            const record = schedulerRecord(db, run.id);
            if (record.data.stopped || !['running', 'waiting'].includes(currentRun.state.status))
              fail('cancelled', 'Stop precedes this client claim.');
            if (activeReservation(record))
              fail('command_conflict', 'Another scheduler transition owns the current call.', true);
            const step = checkedCall(currentRun, call, admission);
            const reservation = reserve(
              admission,
              record.data.reservations,
              { kind: 'tool', step, toolCallId: call.id, webRequest: false },
              now()
            );
            // A lost preparation keeps its full time reservation, but grants no execution authority.
            // Device waits remain idle; only a committed grant takes the active scheduler lease.
            record.data.reservations.push(reservation);
            writeScheduler(db, run.id, record);
            preparation.budget = { runId: run.id, reservation };
            return { events: [] };
          });
          const budget = preparation.budget;
          if (budget) {
            const signal = AbortSignal.timeout(Math.max(1, budget.reservation.deadline - now()));
            const checkDeadline = () => {
              if (signal.aborted || now() >= budget.reservation.deadline)
                fail('limit_exceeded', 'The client claim exceeded its execution deadline.');
            };
            try {
              checkDeadline();
              await abortable(signal, () => adapter.authorize(authority.conversation, run, signal));
              checkDeadline();
              policy = await abortable(signal, () =>
                adapter.policy(
                  store.snapshot()?.conversation ?? authority.conversation,
                  run,
                  original.data,
                  signal
                )
              );
              checkDeadline();
            } catch (error) {
              checkDeadline();
              throw error;
            }
          }
        }
        return {
          call: original.data,
          apply: currentAuthority => {
            const run = storedRun(db, original.runId),
              record = schedulerRecord(db, run.id);
            const call = store.callsForRun(run.id).find(item => item.id === original.id);
            if (!call) fail('invalid_output', 'The stored client call is missing.');
            checkedCall(run, call, admission);
            if (
              call.data.state !== 'settled' &&
              (store.snapshot()?.activeRun?.id !== run.id ||
                store.callsForRun(run.id).find(item => item.data.state !== 'settled')?.id !==
                  call.id)
            )
              fail('command_conflict', 'This call does not own the active run.');
            const accept = (result: unknown, events: EventEnvelope['event'][] = []) => ({
              events,
              reply: {
                status: 'accepted' as const,
                commandId: command.commandId,
                result: jsonValue(result),
              },
            });
            const unavailable =
              currentAuthority.client.revokedAt !== null
                ? 'access_revoked'
                : !currentAuthority.storageReady
                  ? 'storage_unavailable'
                  : !supportsClientCall(currentAuthority, call.data)
                    ? 'unavailable_tool'
                    : null;
            if (unavailable)
              return {
                events: unavailableClientCall(run, record, call, unavailable),
                reply: rejectClientCommand(command.commandId, {
                  code: unavailable,
                  message: 'The designated client cannot safely dispatch or report a result.',
                  retryable: unavailable === 'storage_unavailable',
                }),
              };
            const claimed = readClientGrant(db, call.data);
            if (command.type === 'completeClientTool') {
              if (
                !claimed ||
                claimed.grant.id !== command.grantId ||
                claimed.grant.generation !== command.generation
              )
                fail('access_revoked', 'The result does not belong to the current client grant.');
              // Expiry ends dispatch permission, not reconciliation of this original grant's receipt.
              const outcome = validateOutcome(
                command.result,
                call.data,
                adapter.definitions,
                admission.limits
              );
              if (call.data.result) {
                if (
                  canonicalizeValidatedInput(call.data.result) !==
                  canonicalizeValidatedInput(outcome)
                )
                  fail('command_conflict', 'The client completion is immutable.');
                return accept({ toolCall: call.data, result: call.data.result });
              }
              if (call.data.state !== 'executing')
                fail('access_revoked', 'The grant has no dispatched call.');
              releaseClientReservation(record, call.data, false);
              const events = settleToolOutcome(
                run,
                record,
                call,
                claimed.attemptId,
                outcome,
                run.state.status === 'stopping' || record.data.stopped
              );
              return accept(
                {
                  toolCall: store.callsForRun(run.id).find(item => item.id === call.id)?.data,
                  result: outcome,
                },
                events
              );
            }
            if (call.data.state === 'settled')
              fail('cancelled', 'The client call is already settled.');
            if (claimed) {
              if (call.data.state !== 'executing')
                fail('invalid_output', 'The grant has no executing call.');
              if (
                Date.parse(claimed.grant.expiresAt) <= now() ||
                claimed.outcome !== null ||
                record.data.stopped ||
                run.state.status !== 'running' ||
                bridgeWaitReason(currentAuthority.readiness)
              )
                return {
                  events: unavailableClientCall(run, record, call, 'offline'),
                  reply: rejectClientCommand(command.commandId, {
                    code: 'outcome_unknown',
                    message: 'Reconcile the existing receipt; do not execute again.',
                    retryable: false,
                  }),
                };
              return accept({ grant: claimed.grant, toolCall: call.data });
            }
            if (record.data.stopped || !['running', 'waiting'].includes(run.state.status))
              fail('cancelled', 'Stop precedes this client claim.');
            if (activeReservation(record))
              fail('command_conflict', 'Another scheduler transition owns the current call.', true);
            if (!policy) fail('access_revoked', 'The client claim has no current dispatch policy.');
            const reservation = record.data.reservations.find(
              item => item.id === preparation.budget?.reservation.id
            );
            if (!reservation || reservation.status !== 'reserved')
              fail('command_conflict', 'The client claim has no current time reservation.', true);
            if (now() >= reservation.deadline)
              fail('limit_exceeded', 'The client claim exceeded its execution deadline.');
            record.data.epoch++;
            record.data.currentReservationId = reservation.id;
            writeScheduler(db, run.id, record);
            const conversation = store.snapshot()?.conversation;
            if (!conversation) fail('invalid_input', 'The conversation is missing.');
            const grant = ExecutionGrantSchema.parse({
              id: crypto.randomUUID(),
              conversationId: conversation.id,
              ownerUserId: conversation.ownerUserId,
              clientId: command.clientId,
              toolCallId: call.id,
              context: call.data.context,
              definitionVersion: call.data.definitionVersion,
              inputDigest: call.inputDigest,
              generation: record.data.epoch,
              expiresAt: new Date(reservation.deadline).toISOString(),
            });
            const result = dispatchCall(
              {
                kind: 'tool',
                run,
                conversation,
                admission,
                epoch: record.data.epoch,
                reservation,
                call: call.data,
              },
              policy,
              grant,
              bridgeWaitReason(currentAuthority.readiness)
            );
            if (
              result.decision === 'stale_revision' ||
              result.decision === 'access_revoked' ||
              result.decision === 'unavailable_tool' ||
              result.decision === 'new_call_required'
            )
              return {
                events: result.events,
                reply: rejectClientCommand(command.commandId, {
                  code: result.decision === 'new_call_required' ? 'invalid_input' : result.decision,
                  message: 'The current policy does not permit this client claim.',
                  retryable: result.decision === 'stale_revision',
                }),
              };
            return accept(
              {
                grant: result.decision === 'dispatch' ? grant : null,
                toolCall: store.callsForRun(run.id).find(item => item.id === call.id)?.data,
                decision: result.decision,
              },
              result.events
            );
          },
        };
      },
      now
    );
    const budget = preparation.budget;
    if (budget) {
      try {
        await store.transition({ wakeAt: now() + 1 }, () => {
          const record = schedulerRecord(db, budget.runId);
          const reservation = record.data.reservations.find(
            item => item.id === budget.reservation.id
          );
          // Dispatch owns its lease. Failed checks and losing claims release only their own preparation.
          if (
            reservation?.status === 'reserved' &&
            record.data.currentReservationId !== reservation.id
          ) {
            updateReservation(record, {
              ...finishReservation(reservation, now()),
              status: 'released',
            });
            writeScheduler(db, budget.runId, record);
          }
          return { events: [] };
        });
      } catch {
        return rejectClientCommand(reply.commandId, {
          code: 'storage_unavailable',
          message: 'The client claim budget could not be settled. Retry the same command.',
          retryable: true,
        });
      }
    }
    return reply;
  }
  async function execute(job: Job) {
    const controller = new AbortController();
    const live = {
      runId: job.run.id,
      controller,
      abortable:
        job.kind === 'model' || job.call.effect === 'read' || job.reconciliation !== undefined,
    };
    inFlight = live;
    const timer = setTimeout(
      () =>
        controller.abort(
          new RuntimeError({
            code: 'limit_exceeded',
            message: 'The execution attempt exceeded its deadline.',
            retryable: false,
          })
        ),
      Math.max(1, job.reservation.deadline - now())
    );
    try {
      await abortable(controller.signal, () =>
        adapter.authorize(job.conversation, job.run, controller.signal)
      );
      fence(job);
      controller.signal.throwIfAborted();
      if (job.kind === 'model') {
        const checkpoint = await abortable(controller.signal, () =>
          runModelStep({
            run: job.run,
            conversation: job.conversation,
            model: adapter.model(job.run),
            definitions: adapter.definitions,
            messages: job.history.messages,
            limits: job.admission.limits,
            reservation: job.reservation,
            display: job.display,
            signal: controller.signal,
            now,
            appendPartial: text => appendPartial(job, text),
          })
        );
        await commitModel(job, checkpoint);
      } else return await executeTool(job, controller);
    } catch (error) {
      const failure: unknown = controller.signal.aborted ? controller.signal.reason : error;
      controller.abort(failure);
      await finishFailure(job, failure);
      return false;
    } finally {
      clearTimeout(timer);
      if (inFlight === live) inFlight = undefined;
    }
    return true;
  }
  async function alarm() {
    const run = store.snapshot()?.activeRun;
    if (run) interrupt(run.id);
    for (;;) {
      const job = await claim();
      if (!job) break;
      if (!(await execute(job))) break;
    }
    await maintainAlarm();
  }
  function resolveInteraction(input: unknown, authorize: InteractionAuthorizer) {
    return resolveInteractionCommand(
      store,
      input,
      authorize,
      (_db, interaction, command) => {
        const run = storedRun(db, interaction.toolCall.runId);
        const record = schedulerRecord(db, run.id);
        if (record.data.stopped || !['running', 'waiting'].includes(run.state.status))
          fail('cancelled', 'This run no longer accepts interaction decisions.');
        const call = store.callsForRun(run.id).find(item => item.data.state !== 'settled');
        if (!call || call.id !== interaction.toolCall.id || call.data.state === 'executing')
          fail('invalid_input', 'This interaction no longer owns an undispatched call.');
        const limits = admissionForRun(store, run).limits;
        validateStoredCall(call.data, interaction.toolCall, adapter.definitions, limits);
        const checkpoint = db
          .select()
          .from(s.checkpoints)
          .where(eq(s.checkpoints.id, call.checkpointId))
          .get();
        if (checkpoint?.status !== 'complete')
          fail('invalid_input', 'The interaction has no executable checkpoint.');
        const expected = readCompleteStep(checkpoint.data, adapter.definitions, limits).calls.find(
          item => item.call.id === call.id
        );
        if (!expected) fail('invalid_input', 'The interaction call is absent from its checkpoint.');
        validateStoredCall(call.data, expected.call, adapter.definitions, limits);
        let next: ToolCall;
        let resolved: z.infer<typeof InteractionSchema>;
        const resolution = command.resolution;
        if (interaction.kind === 'approval') {
          if (resolution.kind !== 'approve' && resolution.kind !== 'deny')
            fail('invalid_input', 'An approval requires approve or deny.');
          const approval = {
            interactionId: interaction.id,
            commandId: command.commandId,
            decision: resolution.kind,
          };
          next = {
            ...call.data,
            approval,
            state: resolution.kind === 'approve' ? 'pending' : 'settled',
            result: resolution.kind === 'approve' ? null : { status: 'denied' },
          };
          resolved = { ...interaction, toolCall: next, resolution: approval };
        } else {
          if (
            (resolution.kind !== 'answer' && resolution.kind !== 'dismiss') ||
            !validQuestionResponse(call.data.arguments, resolution)
          )
            fail('invalid_input', 'The answer does not match the question IDs or selection rules.');
          next = {
            ...call.data,
            state: 'settled',
            result:
              resolution.kind === 'dismiss'
                ? { status: 'cancelled' }
                : { status: 'succeeded', output: jsonValue(resolution) },
          };
          resolved = {
            ...interaction,
            toolCall: next,
            resolution:
              resolution.kind === 'dismiss'
                ? { kind: 'dismiss' }
                : {
                    kind: 'answer',
                    choiceIds: resolution.choiceIds,
                    ...(resolution.text === undefined ? {} : { text: resolution.text }),
                  },
          };
        }
        if (next.result) {
          validateOutcome(next.result, next, adapter.definitions, limits);
          settleCall({ ...call, data: next }, next.result);
        } else if (!compareAndSetCall(db, call.id, call.revision, next))
          throw new StoreError('command_conflict');
        const reservation = activeReservation(record);
        if (reservation)
          updateReservation(record, {
            ...finishReservation(reservation, now()),
            status: 'released',
          });
        record.data.epoch++;
        record.data.currentReservationId = null;
        writeScheduler(db, run.id, record);
        return {
          interaction: resolved,
          events: [
            { type: 'interaction', interaction: resolved },
            ...callEvents(run),
            runEvent(run, { status: 'running' }),
          ],
        };
      },
      now
    );
  }
  async function reconcile() {
    const job = await claim(true);
    if (job) await execute(job);
    await maintainAlarm();
  }
  return { alarm, interrupt, resolveInteraction, reconcile, clientTool, clientUnavailable };
}
