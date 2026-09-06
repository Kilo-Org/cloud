import { z } from 'zod';
import {
  SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  wrapperInstanceIdSchema,
} from './sandbox-control-protocol.js';

const timestampSchema = z.number().int().positive();

export const controlStopTargetSchema = z
  .object({
    messageId: z.string().min(1),
    wrapperInstanceId: wrapperInstanceIdSchema.optional(),
    executionDeadlineAt: timestampSchema.optional(),
  })
  .strict();

export const controlStopScopeSchema = z
  .object({
    sandboxId: z.string().min(1),
    wrapperInstanceId: wrapperInstanceIdSchema.optional(),
  })
  .strict();

export const controlStopRequestSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    scope: controlStopScopeSchema,
    targets: z.array(controlStopTargetSchema).min(1),
    cleanupDeadlineAt: timestampSchema,
  })
  .strict();

export const controlSessionStateSchema = z
  .object({
    version: z.literal(1),
    scope: controlStopScopeSchema,
    targets: z.array(controlStopTargetSchema).min(1),
  })
  .strict();

export const controlStopReceiptSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    scope: controlStopScopeSchema,
    targets: z.array(controlStopTargetSchema).min(1),
    cleanupDeadlineAt: timestampSchema,
    state: z.enum(['accepted', 'confirmed', 'unconfirmed', 'rejected']),
    message: z.string().optional(),
  })
  .strict();

export type ControlStopRequest = z.infer<typeof controlStopRequestSchema>;
export type ControlSessionState = z.infer<typeof controlSessionStateSchema>;
export type ControlStopReceipt = z.infer<typeof controlStopReceiptSchema>;

export function createControlStopRequest(
  state: ControlSessionState,
  now = Date.now(),
  operationId = crypto.randomUUID()
): ControlStopRequest {
  return {
    version: 1,
    operationId,
    scope: structuredClone(state.scope),
    targets: structuredClone(state.targets),
    cleanupDeadlineAt: now + SANDBOX_CONTROL_CLEANUP_TIMEOUT_MS,
  };
}
