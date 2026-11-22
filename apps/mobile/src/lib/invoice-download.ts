import { i18n } from '@/i18n';
import {
  getShareFailureKind,
  type ShareFailureKind,
  shareRemoteFile,
} from '@/lib/share-remote-file';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { firstNonEmpty } from '@/lib/utils';

const INVOICE_CACHE_DIRECTORY = 'invoices';

type InvoiceRowState = 'idle' | 'busy' | 'no-affordance';

export const invoiceDownloadFailedMessage = () => i18n.t('organization.invoices.downloadFailed');

export const invoiceSharingUnavailableMessage = () =>
  i18n.t('organization.invoices.sharingUnavailable');

type InvoiceRowStateInput = {
  readonly invoicePdf: string | null;
  readonly sharing: boolean;
};

/**
 * Visual state for an invoice row.
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
 * A retryable failure is answered by tapping the row again (no toast CTA).
 * `sharing-unavailable` is terminal: the message says sharing is not available
 * and there is no retry CTA. `file-unavailable` is terminal too, for the other
 * reason: the document the server holds is gone.
 */
export function selectInvoiceDownloadErrorMessage(kind: ShareFailureKind): string {
  switch (kind) {
    case 'sharing-unavailable': {
      return invoiceSharingUnavailableMessage();
    }
    case 'file-unavailable': {
      return i18n.t('common.fileUnavailable');
    }
    case 'retry':
    case 'general': {
      return invoiceDownloadFailedMessage();
    }
    default: {
      return assertSurfaceFailureHandled(kind);
    }
  }
}

export function getInvoiceDownloadErrorMessage(error: unknown): string {
  return selectInvoiceDownloadErrorMessage(getShareFailureKind(error));
}

export function getInvoicePdfFilename(invoice: {
  readonly id: string;
  readonly number: string | null;
  readonly description?: string | null;
}): string {
  const stem = firstNonEmpty(invoice.number, invoice.description, invoice.id);
  return stem.toLowerCase().endsWith('.pdf') ? stem : `${stem}.pdf`;
}

export async function shareInvoicePdf(invoice: {
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
