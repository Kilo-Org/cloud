import { readTrpcErrorField } from '@/lib/trpc-error';

const recheckListeners = new Set<() => void>();

/**
 * Notifies every recheck listener when the error carries
 * `upstreamCode === 'app_update_required'`. A refusal is authoritative at the
 * moment it is issued, but the server's min-version read is cached, so the
 * listener must re-check the uncached REST endpoint. Any other error is a
 * no-op.
 */
export function reportTrpcError(error: unknown): void {
  if (readTrpcErrorField(error, 'upstreamCode') !== 'app_update_required') {
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
