import { z } from 'zod';
import { RUNTIME_LAUNCH_ID_PATTERN } from '../../sandbox-control/runtime-launch-receipt.js';
import {
  runtimeLaunchSelectionSchema,
  type RuntimeLaunchSelection,
} from '../../sandbox-control/runtime-launch.js';

/**
 * The durable owner of an allocation's runtime selection. One versioned
 * fixed-key record is written with synchronous `storage.kv` inside the
 * allocation SQL transaction, so identity and selection commit together or
 * neither commits. It stores no grant, secret, environment or credential, and no
 * deadline: the SQL `create_deadline_at` stays the only outer-deadline authority.
 */

export const RUNTIME_LAUNCH_KEY = 'runtime_launch';

export const runtimeLaunchIntentSchema = z
  .object({
    version: z.literal(1),
    allocationId: z.string().min(1),
    launchId: z.string().regex(RUNTIME_LAUNCH_ID_PATTERN),
    selection: runtimeLaunchSelectionSchema,
  })
  .strict();

export type RuntimeLaunchIntent = z.infer<typeof runtimeLaunchIntentSchema>;

export type { RuntimeLaunchSelection };

/** The synchronous KV surface the transactional write needs. Mirrors `runtime-contract`. */
export type RuntimeLaunchIntentStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
};

/**
 * A read outcome. Missing is `legacy` (reconcile baked, never adopt today's
 * descriptor); a present but malformed or mismatched record is `malformed` and
 * the caller must fail closed rather than launch.
 */
export type RuntimeLaunchIntentRead =
  | { kind: 'intent'; intent: RuntimeLaunchIntent }
  | { kind: 'legacy' }
  | { kind: 'malformed' };

export function readRuntimeLaunchIntent(
  storage: RuntimeLaunchIntentStorage,
  allocationId: string | null
): RuntimeLaunchIntentRead {
  if (allocationId === null) return { kind: 'legacy' };
  const stored = storage.get(RUNTIME_LAUNCH_KEY);
  if (stored === undefined) return { kind: 'legacy' };
  const parsed = runtimeLaunchIntentSchema.safeParse(stored);
  if (!parsed.success) return { kind: 'malformed' };
  if (parsed.data.allocationId !== allocationId) return { kind: 'malformed' };
  return { kind: 'intent', intent: parsed.data };
}

/**
 * The selection to consume for an allocation. A missing legacy record reconciles
 * baked; a present but malformed or mismatched record fails closed instead of
 * adopting today's descriptor.
 */
export function runtimeLaunchSelectionFor(
  storage: RuntimeLaunchIntentStorage,
  allocationId: string | null
): RuntimeLaunchSelection {
  const read = readRuntimeLaunchIntent(storage, allocationId);
  if (read.kind === 'malformed') throw new Error('runtime launch intent is malformed');
  return read.kind === 'intent' ? read.intent.selection : { kind: 'baked' };
}

/**
 * Write the fresh intent for a new allocation identity. Called synchronously
 * inside the allocation SQL transaction, beside `resetRuntimeContract`.
 */
export function writeRuntimeLaunchIntent(
  storage: RuntimeLaunchIntentStorage,
  intent: RuntimeLaunchIntent
): void {
  storage.put(RUNTIME_LAUNCH_KEY, runtimeLaunchIntentSchema.parse(intent));
}

/** Delete the intent atomically when the allocation identity clears. */
export function clearRuntimeLaunchIntent(storage: RuntimeLaunchIntentStorage): void {
  storage.delete(RUNTIME_LAUNCH_KEY);
}

/**
 * Replace only the physical nonce after a confirmed fallback cleanup. The
 * selection and the outer deadline (owned by SQL) are retained. The caller must
 * present the nonce it expects to replace; a mismatched expected nonce, or a
 * missing/malformed record, is refused so a delayed rotation cannot overwrite a
 * replacement's nonce or adopt today's config.
 */
export function rotateRuntimeLaunchNonce(
  storage: RuntimeLaunchIntentStorage,
  allocationId: string,
  expectedLaunchId: string,
  launchId: string
): RuntimeLaunchIntent {
  const read = readRuntimeLaunchIntent(storage, allocationId);
  if (read.kind !== 'intent' || read.intent.launchId !== expectedLaunchId) {
    throw new Error('runtime launch intent is not available to rotate');
  }
  const next: RuntimeLaunchIntent = { ...read.intent, launchId };
  writeRuntimeLaunchIntent(storage, next);
  return next;
}
