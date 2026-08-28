import { z } from 'zod';
import type { ExecutionIntent, JournalScope } from './journal';

export const BridgeReadinessSchema = z.strictObject({
  available: z.boolean(),
  foreground: z.boolean(),
  connectivity: z.enum(['confirmed', 'offline', 'unknown']),
  unlock: z.enum(['ready', 'locked', 'unknown']),
  gesture: z.enum(['not_required', 'required', 'satisfied']),
});
export type BridgeReadiness = z.infer<typeof BridgeReadinessSchema>;
export function bridgeWaitReason(input: unknown) {
  const readiness = BridgeReadinessSchema.parse(input);
  if (!readiness.available) return 'unavailable';
  if (!readiness.foreground) return 'background';
  if (readiness.connectivity !== 'confirmed') return 'offline';
  if (readiness.unlock !== 'ready') return 'locked';
  if (readiness.gesture === 'required') return 'gesture';
  return null;
}
export type ClientBridge = {
  readiness: (scope: JournalScope, execution: ExecutionIntent) => BridgeReadiness;
  // Recheck account, grant, and every readiness gate at the actual effect boundary. Return a
  // ToolOutcome only for a known result; throw on uncertainty. Never retry an effect internally.
  execute: (scope: JournalScope, execution: ExecutionIntent) => Promise<unknown>;
  // Read evidence only. null means unknown, NOT permission to execute or transfer the grant.
  reconcileReceipt: (scope: JournalScope, execution: ExecutionIntent) => Promise<unknown>;
};
