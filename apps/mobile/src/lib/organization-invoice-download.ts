import {
  getShareRemoteFileReason,
  shareRemoteFile,
  type ShareRemoteFileReason,
} from '@/lib/share-remote-file';
import { firstNonEmpty } from '@/lib/utils';

const INVOICE_CACHE_DIRECTORY = 'org-invoices';

type InvoiceRowState = 'idle' | 'busy' | 'no-affordance';

export const INVOICE_DOWNLOAD_FAILED_MESSAGE =
  "Couldn't download invoice. Check your connection and try again.";

export const INVOICE_SHARING_UNAVAILABLE_MESSAGE = 'Sharing is not available on this device.';

type InvoiceRowStateInput = {
  readonly invoicePdf: string | null;
  readonly sharing: boolean;
};

/**
 * Visual state for an organization invoice row.
 *
 * Exactly three states: no PDF → no affordance; sharing in flight → busy;
 * otherwise idle. Failures are transient (toast then idle) and are not modeled
 * as a fourth row state.
 */
export function selectInvoiceRowState(input: InvoiceRowStateInput): InvoiceRowState {
  if (input.invoicePdf === null) {
    return 'no-affordance';
  }
  if (input.sharing) {
    return 'busy';
  }
  return 'idle';
}

/**
 * Toast copy for a failed invoice download/share.
 *
 * `download-failed` is retryable by tapping the row again (no toast CTA).
 * `sharing-unavailable` is terminal: the message says sharing is not available
 * and there is no retry CTA.
 */
export function selectInvoiceDownloadErrorMessage(reason: ShareRemoteFileReason): string {
  if (reason === 'sharing-unavailable') {
    return INVOICE_SHARING_UNAVAILABLE_MESSAGE;
  }
  return INVOICE_DOWNLOAD_FAILED_MESSAGE;
}

export function getInvoiceDownloadErrorMessage(error: unknown): string {
  const reason = getShareRemoteFileReason(error) ?? 'download-failed';
  return selectInvoiceDownloadErrorMessage(reason);
}

export function getInvoicePdfFilename(invoice: {
  readonly id: string;
  readonly number: string | null;
  readonly description?: string | null;
}): string {
  const stem = firstNonEmpty(invoice.number, invoice.description, invoice.id);
  return stem.toLowerCase().endsWith('.pdf') ? stem : `${stem}.pdf`;
}

export async function shareOrganizationInvoicePdf(invoice: {
  readonly id: string;
  readonly number: string | null;
  readonly description?: string | null;
  readonly invoice_pdf: string;
}): Promise<void> {
  await shareRemoteFile({
    url: invoice.invoice_pdf,
    cacheDirectoryName: INVOICE_CACHE_DIRECTORY,
    cacheKey: invoice.id,
    filename: getInvoicePdfFilename(invoice),
  });
}
