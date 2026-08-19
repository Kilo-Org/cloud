import * as z from 'zod';

type Listener = () => void;

const listeners = new Set<Listener>();
let forceUpdateRequired = false;
let clientUpToDate = false;

const upstreamCodePayloadSchema = z.object({ upstreamCode: z.string().optional() });

// `data` and `shape` are opaque here: each is parsed independently so a
// present-but-invalid `data` still falls through to `shape`, exactly as the
// pre-Zod code did (read `data` first, then `shape.data`).
const trpcErrorEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  shape: z.unknown().optional(),
});

const shapeEnvelopeSchema = z.object({ data: z.unknown().optional() }).nullish();

function readUpstreamCode(error: unknown): string | undefined {
  const envelope = trpcErrorEnvelopeSchema.safeParse(error);
  if (!envelope.success) {
    return undefined;
  }
  const direct = upstreamCodePayloadSchema.safeParse(envelope.data.data);
  if (direct.success) {
    return direct.data.upstreamCode;
  }
  const shape = shapeEnvelopeSchema.safeParse(envelope.data.shape);
  if (!shape.success || shape.data == null) {
    return undefined;
  }
  const shaped = upstreamCodePayloadSchema.safeParse(shape.data.data);
  return shaped.success ? shaped.data.upstreamCode : undefined;
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Flips the module-level flag to true (and notifies) when the error carries
 * `upstreamCode === 'app_update_required'`. Any other error is a no-op.
 */
export function reportTrpcError(error: unknown): void {
  if (readUpstreamCode(error) !== 'app_update_required' || forceUpdateRequired || clientUpToDate) {
    return;
  }
  forceUpdateRequired = true;
  notify();
}

/**
 * Marks the client's own check as authoritative `up-to-date`. Until
 * `markClientUpdateRequired` is called, a stale server `app_update_required`
 * refusal must not re-set the signal.
 */
export function markClientUpToDate(): void {
  clientUpToDate = true;
}

/**
 * Marks the client's own check as `update-required`, re-arming the signal so a
 * subsequent server refusal can set it again.
 */
export function markClientUpdateRequired(): void {
  clientUpToDate = false;
}

export function subscribeToForceUpdateSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getForceUpdateSignalSnapshot(): boolean {
  return forceUpdateRequired;
}

/**
 * Resets the flag to false and notifies. Load-bearing: without it, lowering the
 * minimum can never clear the block.
 */
export function clearForceUpdateSignal(): void {
  if (!forceUpdateRequired) {
    return;
  }
  forceUpdateRequired = false;
  notify();
}
