import { z } from 'zod';
import type { ErrorSchema, Run } from '@kilocode/agent-harness/contracts';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import { SendResultSchema } from './commands';
import type { ConversationStore } from './db/store';

export class RuntimeError extends Error {
  constructor(readonly detail: z.infer<typeof ErrorSchema>) {
    super(detail.message);
  }
}
export function fail(
  code: z.infer<typeof ErrorSchema>['code'],
  message: string,
  retryable = false
): never {
  throw new RuntimeError({ code, message, retryable });
}
export const bytes = (value: unknown) =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;

export function admissionForRun(store: ConversationStore, run: Run) {
  const reply = store.getCommand(run.id)?.reply;
  if (reply?.status !== 'accepted') fail('invalid_input', 'The run has no accepted admission.');
  const parsed = SendResultSchema.safeParse(reply.result);
  if (!parsed.success) fail('invalid_input', 'The run has no valid limits or model price bounds.');
  const admission = parsed.data;
  if (
    admission.runId !== run.id ||
    admission.messageId !== run.inputMessageId ||
    canonicalizeValidatedInput(admission.context) !==
      canonicalizeValidatedInput(store.snapshot()?.conversation.context)
  )
    fail('invalid_input', 'The admission does not match the stored run.');
  return admission;
}
export type Admission = z.infer<typeof SendResultSchema>;
export type RunLimits = Admission['limits'];

export const ReservationSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['model', 'tool']),
  step: z.int().positive(),
  toolCallId: z.uuid().nullable(),
  webRequest: z.boolean(),
  startedAt: z.int().nonnegative(),
  deadline: z.int().nonnegative(),
  activeMs: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  status: z.enum(['reserved', 'finished', 'interrupted', 'released']),
});
export type Reservation = z.infer<typeof ReservationSchema>;

// These are execution ceilings, not billing entries. The gateway alone charges model usage.
// Unknown/lost responses retain their full reservation; SDK usage never creates another charge.
export function reserve(
  admission: Admission,
  previous: Reservation[],
  input:
    | { kind: 'model'; step: number; inputTokens: number }
    | { kind: 'tool'; step: number; toolCallId: string; webRequest: boolean },
  now: number
): Reservation {
  const { limits, model } = admission;
  const activeRemaining =
    limits.activeRunMs - previous.reduce((sum, item) => sum + item.activeMs, 0);
  if (activeRemaining <= 0) fail('limit_exceeded', 'The active execution time limit is exhausted.');
  const time = Math.min(
    activeRemaining,
    input.kind === 'model' ? limits.modelAttemptMs : limits.toolAttemptMs
  );
  let inputTokens = 0,
    outputTokens = 0,
    costUsd = 0;
  if (input.kind === 'model') {
    if (
      previous.filter(item => item.kind === 'model').length >= limits.modelSteps ||
      input.step > limits.modelSteps ||
      previous.filter(item => item.kind === 'model' && item.step === input.step).length >= 2
    )
      fail('limit_exceeded', 'The model request or regeneration limit is exhausted.');
    inputTokens = z.int().nonnegative().parse(input.inputTokens);
    outputTokens = Math.min(limits.modelOutputTokens, model.contextTokens - inputTokens);
    if (inputTokens > limits.modelInputTokens || outputTokens <= 0)
      fail('limit_exceeded', 'The canonical model history exceeds the context limit.');
    costUsd =
      (inputTokens * model.inputUsdPerMillion + outputTokens * model.outputUsdPerMillion) /
      1_000_000;
    if (previous.reduce((sum, item) => sum + item.costUsd, 0) + costUsd > limits.modelCostUsd)
      fail('limit_exceeded', 'The model inference cost limit is exhausted.');
  } else {
    if (
      previous.filter(item => item.kind === 'tool' && item.status !== 'released').length >=
        limits.calls ||
      (input.webRequest &&
        previous.filter(item => item.webRequest && item.status !== 'released').length >=
          limits.webRequests)
    )
      fail('limit_exceeded', 'The tool request limit is exhausted.');
  }
  return ReservationSchema.parse({
    id: crypto.randomUUID(),
    kind: input.kind,
    step: input.step,
    toolCallId: input.kind === 'tool' ? input.toolCallId : null,
    webRequest: input.kind === 'tool' && input.webRequest,
    startedAt: now,
    deadline: now + time,
    activeMs: time,
    inputTokens,
    outputTokens,
    costUsd,
    status: 'reserved',
  });
}

export function finishReservation(reservation: Reservation, now: number): Reservation {
  return ReservationSchema.parse({
    ...reservation,
    status: 'finished',
    activeMs: Math.min(reservation.activeMs, Math.max(0, now - reservation.startedAt)),
  });
}
