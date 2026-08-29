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
        const reservation = run ? activeReservation(schedulerRecord(db, run.id)) : undefined;
        const projection = db
          .select({ dueAt: s.projectionWork.dueAt })
          .from(s.projectionWork)
          .where(isNull(s.projectionWork.acknowledgedAt))
          .orderBy(asc(s.projectionWork.dueAt))
          .limit(1)
          .get();
        const runnable = run && ['queued', 'running', 'stopping'].includes(run.state.status);
        const due = reservation ? reservation.deadline : runnable ? now() + 1 : null;
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
      return step.calls.map((item, index) => {
        const stored = calls.find(call => call.id === item.call.id);
        if (!stored || stored.checkpointId !== row.id)
          fail('invalid_output', 'The checkpoint has no matching stored call.');
        const call = validateStoredCall(stored.data, item.call, adapter.definitions, limits);
        // A call owns its display message. Up to 32 bounded outputs must not form one oversized event.
        return displayMessage(
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
        );
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
      runEvent(run, {
        status: 'waiting',
        waiting: { reason: 'reconciliation', toolCallId: call.id },
      }),
    ];
  }
  function stopRun(run: Run, record: SchedulerRecord): EventEnvelope['event'][] {
    record.data.stopped = true;
    const reservation = activeReservation(record);
    const calls = store.callsForRun(run.id);
    const mutation = calls.find(
      call => call.data.state === 'executing' && call.data.effect !== 'read'
    );
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
      // A supported read can abort. A mutation retains its lease and can report actual late completion.
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

  async function claim(reconcile = false): Promise<Job | null> {
    const snapshot = store.snapshot();
    if (!snapshot || (!snapshot.activeRun && !snapshot.queuedRuns.length)) return null;
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
          if (executing.data.effect !== 'read')
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
              adapter.system
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
          const checkpoint = checkpointRows.find(row => row.id === pending.checkpointId);
          if (!checkpoint || checkpoint.status !== 'complete')
            fail('invalid_output', 'A partial cannot authorize dispatch.');
          const complete = readCompleteStep(checkpoint.data, adapter.definitions, admission.limits);
          const expected = complete.calls.find(item => item.call.id === pending.id);
          if (
            !expected ||
            expected.call.runId !== run.id ||
            canonicalizeValidatedInput(expected.call.context) !==
              canonicalizeValidatedInput(currentSnapshot.conversation.context)
          )
            fail('invalid_output', 'The call is absent from its scoped checkpoint.');
          validateStoredCall(pending.data, expected.call, adapter.definitions, admission.limits);
          if (
            pending.inputDigest !==
              createHash('sha256')
                .update(canonicalizeValidatedInput(pending.data.arguments))
                .digest('hex') ||
            canonicalizeValidatedInput(
              calls.filter(call => call.checkpointId === checkpoint.id).map(call => call.id)
            ) !== canonicalizeValidatedInput(complete.calls.map(item => item.call.id))
          )
            fail('invalid_output', 'The stored call digest or order has changed.');
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
        if (call.data.state === 'executing' && call.data.effect !== 'read')
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
          // Only durable answers and a14 client grants can release these gates, not adapter hints.
          questionAnswered: false,
          clientReady: false,
        },
        job.reservation.id,
        job.epoch
      );
      if (decision === 'dispatch') {
        dispatched = true;
        return {
          events: [
            ...closeInteraction(db, store, { ...call.data, state: 'executing' }, 'approve'),
            ...callEvents(job.run),
          ],
        };
      }
      const record = schedulerRecord(db, job.run.id);
      // No external request occurred. Release this request slot, but retain time spent checking authority.
      updateReservation(record, {
        ...finishReservation(job.reservation, now()),
        status: 'released',
      });
      record.data.currentReservationId = null;
      writeScheduler(db, job.run.id, record);
      if (decision === 'approval' || decision === 'question' || decision === 'client') {
        const waiting = { ...call.data, state: 'waiting' as const };
        if (!compareAndSetCall(db, call.id, call.revision, waiting))
          throw new StoreError('command_conflict');
        return {
          events: [
            ...(conversation.permissionMode === 'yolo'
              ? closeInteraction(db, store, waiting, 'approve')
              : []),
            ...(decision === 'client' ? [] : [waitForInteraction(store, waiting, decision)]),
            ...callEvents(job.run),
            runEvent(job.run, {
              status: 'waiting',
              waiting: { reason: decision, toolCallId: call.id },
            }),
          ],
        };
      }
      if (decision === 'stale_revision') {
        retryPolicy = true;
        return { events: [runEvent(job.run, { status: 'running' })] };
      }
      if (decision === 'already_dispatched') return { events: [] };
      if (decision === 'denied') {
        settleCall(call, { status: 'denied' });
        return { events: callEvents(job.run) };
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
      return {
        events: [
          ...(pendingEvents.length ? pendingEvents : callEvents(job.run)),
          runEvent(job.run, { status: 'failed', error }),
        ],
      };
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
      if (outcome.status === 'outcome_unknown') {
        if (outcome.providerReference)
          db.update(s.attempts)
            .set({ providerReference: outcome.providerReference })
            .where(eq(s.attempts.id, attemptId))
            .run();
        return {
          events: stopping
            ? stopRun(run, record)
            : unknownOutcome(run, call.data, outcome.reason, outcome.providerReference),
        };
      }
      db.update(s.attempts)
        .set({ outcome: jsonValue(outcome) })
        .where(eq(s.attempts.id, attemptId))
        .run();
      settleCall(call, outcome);
      return { events: stopping ? stopRun(run, record) : callEvents(run) };
    });
    return committed;
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
  return { alarm, interrupt, resolveInteraction, reconcile };
}
