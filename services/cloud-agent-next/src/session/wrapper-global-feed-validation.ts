import * as z from 'zod';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { WrapperRuntimeState } from './wrapper-runtime-state.js';

export const kiloGlobalFeedValidationSchema = z.object({
  kiloSessionId: z.string().min(1),
  wrapperRunId: z.string().min(1),
  wrapperGeneration: z.number().int().nonnegative(),
  wrapperConnectionId: z.string().min(1),
});

export type KiloGlobalFeedValidationParams = z.infer<typeof kiloGlobalFeedValidationSchema>;

export type KiloGlobalFeedValidationResult =
  | { success: true }
  | { success: false; status: number; message: string };

export function validateKiloGlobalFeedProducerIdentity(params: {
  metadata: SessionMetadata | null;
  runtimeState: WrapperRuntimeState;
  producer: KiloGlobalFeedValidationParams;
}): KiloGlobalFeedValidationResult {
  const { metadata, runtimeState, producer } = params;

  if (!metadata) {
    return { success: false, status: 404, message: 'Session metadata not found' };
  }

  if (metadata.auth.kiloSessionId !== producer.kiloSessionId) {
    return { success: false, status: 403, message: 'Root Kilo session mismatch' };
  }

  if (runtimeState.wrapperRunId !== producer.wrapperRunId) {
    return { success: false, status: 409, message: 'Stale wrapper run' };
  }

  if (
    runtimeState.wrapperGeneration !== producer.wrapperGeneration ||
    runtimeState.wrapperConnectionId !== producer.wrapperConnectionId
  ) {
    return { success: false, status: 409, message: 'Stale wrapper connection' };
  }

  return { success: true };
}
