import { type QueryErrorVariant } from '@/components/query-error';

/** The connectivity states the offline banner commits, as a reader sees them. */
export type CommittedConnectivity = 'online' | 'offline' | 'unknown';

/**
 * The error state the invoices screen presents for a failed first page.
 *
 * A thrown `NOT_FOUND` or a permission loss can never be fixed by retrying, so
 * those keep their own permanent state. Any other failure is retryable, and a
 * device the connectivity probe has confirmed offline presents that cause
 * rather than a generic server fault; `unknown` keeps the neutral copy.
 */
export function selectInvoiceErrorVariant(
  errorCode: string | undefined,
  connectivity: CommittedConnectivity
): QueryErrorVariant {
  if (errorCode === 'NOT_FOUND') {
    return 'not-found';
  }
  if (errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED') {
    return 'permission';
  }
  return connectivity === 'offline' ? 'offline' : 'neutral';
}
