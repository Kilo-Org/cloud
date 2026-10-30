import { type QueryErrorVariant } from '@/components/query-error';
import { trpcErrorVariant } from '@/lib/trpc-error';

/** The connectivity states the offline banner commits, as a reader sees them. */
export type CommittedConnectivity = 'online' | 'offline' | 'unknown';

/**
 * The error state the invoices screen presents for a failed first page.
 *
 * A thrown `NOT_FOUND` or a permission loss can never be fixed by retrying, so
 * those keep their own permanent state and win over connectivity: the server
 * did answer. Otherwise a device the connectivity probe has confirmed offline
 * presents that cause, then a request that ran out its deadline presents the
 * retryable slow-response state, and everything else keeps the neutral copy.
 */
export function selectInvoiceErrorVariant(
  error: unknown,
  connectivity: CommittedConnectivity
): QueryErrorVariant {
  const variant = trpcErrorVariant(error);
  if (variant === 'permission' || variant === 'not-found') {
    return variant;
  }
  if (connectivity === 'offline') {
    return 'offline';
  }
  return variant === 'timeout' ? 'timeout' : 'neutral';
}
