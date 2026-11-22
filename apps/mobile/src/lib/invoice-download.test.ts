import { describe, expect, it, vi } from 'vitest';

import {
  getInvoiceDownloadErrorMessage,
  getInvoicePdfFilename,
  invoiceDownloadFailedMessage,
  invoiceSharingUnavailableMessage,
  selectInvoiceDownloadErrorMessage,
  selectInvoiceRowState,
} from '@/lib/invoice-download';
import { ShareRemoteFileError } from '@/lib/share-remote-file';
import { i18n } from '@/i18n';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: Object.assign(vi.fn(), { downloadFileAsync: vi.fn() }),
  FileMode: { WriteOnly: 'w' },
  Paths: { cache: 'file:///cache' },
}));

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

describe('selectInvoiceRowState', () => {
  it('selects no-affordance when invoice_pdf is null', () => {
    expect(selectInvoiceRowState({ invoicePdf: null, sharing: false })).toBe('no-affordance');
    expect(selectInvoiceRowState({ invoicePdf: null, sharing: true })).toBe('no-affordance');
  });

  it('selects busy while a download/share is in flight', () => {
    expect(
      selectInvoiceRowState({
        invoicePdf: 'https://files.stripe.com/invoices/inv_1.pdf',
        sharing: true,
      })
    ).toBe('busy');
  });

  it('selects idle when a PDF is available and nothing is in flight', () => {
    expect(
      selectInvoiceRowState({
        invoicePdf: 'https://files.stripe.com/invoices/inv_1.pdf',
        sharing: false,
      })
    ).toBe('idle');
  });
});

describe('selectInvoiceDownloadErrorMessage', () => {
  it('maps retry to a retryable download message with no CTA', () => {
    expect(selectInvoiceDownloadErrorMessage('retry')).toBe(invoiceDownloadFailedMessage());
    // Retry is by tapping the row again; the toast itself has no action CTA.
    expect(invoiceDownloadFailedMessage().toLowerCase()).toContain('try again');
  });

  it('maps sharing-unavailable to a distinct terminal message with no retry CTA', () => {
    expect(selectInvoiceDownloadErrorMessage('sharing-unavailable')).toBe(
      invoiceSharingUnavailableMessage()
    );
    expect(invoiceSharingUnavailableMessage().toLowerCase()).toContain('not available');
    expect(invoiceSharingUnavailableMessage().toLowerCase()).not.toContain('try again');
  });

  it('maps file-unavailable to the shared copy that the document is gone', () => {
    expect(selectInvoiceDownloadErrorMessage('file-unavailable')).toBe(
      i18n.t('common.fileUnavailable')
    );
    // Asking again cannot succeed, so the copy offers no retry.
    expect(i18n.t('common.fileUnavailable').toLowerCase()).not.toContain('try again');
  });

  it('maps an untyped failure to the generic download message', () => {
    expect(selectInvoiceDownloadErrorMessage('general')).toBe(invoiceDownloadFailedMessage());
  });
});

describe('getInvoiceDownloadErrorMessage', () => {
  it('reads the failure kind from ShareRemoteFileError', () => {
    expect(getInvoiceDownloadErrorMessage(new ShareRemoteFileError('sharing-unavailable'))).toBe(
      invoiceSharingUnavailableMessage()
    );
    expect(getInvoiceDownloadErrorMessage(new ShareRemoteFileError('download-network'))).toBe(
      invoiceDownloadFailedMessage()
    );
    expect(getInvoiceDownloadErrorMessage(new ShareRemoteFileError('download-timeout'))).toBe(
      invoiceDownloadFailedMessage()
    );
  });

  it('reads a definitive 4xx as a document that is gone', () => {
    for (const httpStatus of [404, 410]) {
      expect(
        getInvoiceDownloadErrorMessage(
          new ShareRemoteFileError('download-http-status', { httpStatus })
        )
      ).toBe(i18n.t('common.fileUnavailable'));
    }
  });

  it('keeps a re-signed or transient status on the retry copy', () => {
    // 401/403 are a presigned link a later tap re-signs; 408/429/5xx are the
    // origin's own bad moment.
    for (const httpStatus of [401, 403, 408, 429, 503]) {
      expect(
        getInvoiceDownloadErrorMessage(
          new ShareRemoteFileError('download-http-status', { httpStatus })
        )
      ).toBe(invoiceDownloadFailedMessage());
    }
  });

  it('falls back to the download message for unknown errors', () => {
    expect(getInvoiceDownloadErrorMessage(new Error('boom'))).toBe(invoiceDownloadFailedMessage());
  });
});

describe('getInvoicePdfFilename', () => {
  it('prefers number, then description, then id, and appends .pdf', () => {
    expect(
      getInvoicePdfFilename({
        id: 'in_1',
        number: 'INV-100',
        description: 'Seat invoice',
      })
    ).toBe('INV-100.pdf');
    expect(
      getInvoicePdfFilename({
        id: 'in_1',
        number: null,
        description: 'Seat invoice',
      })
    ).toBe('Seat invoice.pdf');
    expect(getInvoicePdfFilename({ id: 'in_1', number: null, description: null })).toBe('in_1.pdf');
  });
});
