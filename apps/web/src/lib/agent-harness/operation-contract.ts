import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { ErrorSchema } from '@kilocode/agent-harness/contracts';
import { ToolRequestSchema } from '@kilocode/agent-harness/tools';
import { harnessInputDigest } from './authorization';

export const Id = z.uuid().transform(value => value.toLowerCase());
export const Time = z.int().nonnegative();
const identity = { conversationId: Id, operationId: Id };
// The Worker supplies these fields from the committed reservation and its owning run checkpoint.
const WebReservation = z.strictObject({
  id: Id,
  runId: Id,
  toolCallId: Id,
  startedAt: Time,
  deadline: Time,
  kind: z.literal('tool'),
  status: z.literal('reserved'),
  webRequest: z.literal(true),
});
export const HarnessOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal(['execute', 'reconcile']),
    ...identity,
    runId: Id,
    toolCallId: Id,
    request: ToolRequestSchema,
    // Legacy reconciliation omits this time; retain absence until those stored attempts are gone.
    dispatchStartedAt: Time.optional(),
    reservation: WebReservation.optional(),
  }),
  z.strictObject({
    type: z.literal('read'),
    ...identity,
    purpose: z.enum(['read', 'import', 'project', 'drain']),
  }),
  z.strictObject({
    type: z.literal('history'),
    ...identity,
    limit: z.int().min(1).max(50).default(50),
  }),
  z.strictObject({
    type: z.literal('projection'),
    ...identity,
    projection: z.strictObject({
      id: Id,
      key: z.string().min(1),
      role: z.enum(['user', 'assistant']),
      content: z.string(),
      clientId: z.string().nullable().default(null),
      createdAt: z.iso.datetime(),
    }),
  }),
  z.strictObject({ type: z.literal('retirement'), ...identity, generation: Time }),
]);
export type HarnessOperation = z.infer<typeof HarnessOperationSchema>;
export function harnessOperationScope(raw: unknown) {
  const input = HarnessOperationSchema.parse(raw);
  return {
    audience: 'agent-harness:operations',
    conversationId: input.conversationId,
    operation: input.type,
    definitionVersion: '1',
    // Validate before serialization so malformed fields cannot disappear from the signed input.
    inputDigest: harnessInputDigest(JSON.parse(JSON.stringify(input))),
    dispatchId: input.operationId,
    target: { kind: 'backend' as const },
  };
}
export const messages = {
  stale_revision: 'Refresh the conversation before continuing.',
  command_conflict: 'This operation has different recorded input.',
  access_revoked: 'Access to this conversation is unavailable.',
  retired: 'This conversation is retired.',
  storage_unavailable: 'The operation service is unavailable. Retry synchronization.',
  unsupported_protocol: 'Update the client before continuing.',
  unavailable_tool: 'This tool is unavailable in the current context.',
  reauthorization_required: 'Reconnect the integration in this context.',
  invalid_input: 'The operation input is invalid.',
  invalid_output: 'The operation returned invalid output.',
  limit_exceeded: 'The operation exceeds its limit.',
  cancelled: 'The operation was cancelled.',
  outcome_unknown: 'Check the recorded outcome; do not repeat this mutation.',
} satisfies Record<z.infer<typeof ErrorSchema>['code'], string>;
export const safeError = (error: z.infer<typeof ErrorSchema>) => ({
  code: error.code,
  message: messages[error.code],
  retryable: error.retryable,
});
export function harnessOperationFailure(error: unknown, uncertain = false) {
  const codes: Partial<Record<TRPCError['code'], z.infer<typeof ErrorSchema>['code']>> = {
    FORBIDDEN: 'access_revoked',
    UNAUTHORIZED: 'access_revoked',
    BAD_REQUEST: 'invalid_input',
    PRECONDITION_FAILED: 'unavailable_tool',
    NOT_FOUND: 'unavailable_tool',
    CONFLICT: 'command_conflict',
    PAYMENT_REQUIRED: 'limit_exceeded',
    PAYLOAD_TOO_LARGE: 'limit_exceeded',
    UNPROCESSABLE_CONTENT: 'invalid_output',
    SERVICE_UNAVAILABLE: 'unavailable_tool',
  };
  const rejection =
    error instanceof TRPCError &&
    [
      'FORBIDDEN',
      'UNAUTHORIZED',
      'BAD_REQUEST',
      'PRECONDITION_FAILED',
      'PAYMENT_REQUIRED',
      'CONFLICT',
    ].includes(error.code);
  const code =
    uncertain && !rejection
      ? 'outcome_unknown'
      : error instanceof TRPCError
        ? error.code === 'PRECONDITION_FAILED' && error.message === 'reauthorization_required'
          ? 'reauthorization_required'
          : (codes[error.code] ?? 'storage_unavailable')
        : error instanceof z.ZodError
          ? 'invalid_output'
          : 'storage_unavailable';
  return {
    error: safeError({
      code,
      message: '',
      retryable:
        code === 'storage_unavailable' ||
        (code === 'unavailable_tool' &&
          error instanceof TRPCError &&
          error.code === 'SERVICE_UNAVAILABLE'),
    }),
  };
}
export function bounded<T>(value: T, limit = 64 * 1024): T {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT' });
  }
  if (json === undefined) throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT' });
  if (Buffer.byteLength(json, 'utf8') > limit) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE' });
  return value;
}
export const invalid = () => {
  throw new TRPCError({ code: 'BAD_REQUEST' });
};
