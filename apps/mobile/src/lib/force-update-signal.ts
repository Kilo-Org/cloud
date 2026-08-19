import * as z from 'zod';

const recheckListeners = new Set<() => void>();

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

/**
 * Notifies every recheck listener when the error carries
 * `upstreamCode === 'app_update_required'`. A refusal is authoritative at the
 * moment it is issued, but the server's min-version read is cached, so the
 * listener must re-check the uncached REST endpoint. Any other error is a
 * no-op.
 */
export function reportTrpcError(error: unknown): void {
  if (readUpstreamCode(error) !== 'app_update_required') {
    return;
  }
  for (const listener of recheckListeners) {
    listener();
  }
}

export function subscribeToForceUpdateRecheck(listener: () => void): () => void {
  recheckListeners.add(listener);
  return () => {
    recheckListeners.delete(listener);
  };
}
