import { describe, expect, it, vi } from 'vitest';

import {
  getInvoiceDownloadErrorMessage,
  getInvoicePdfFilename,
  invoiceDownloadFailedMessage,
  invoiceSharingUnavailableMessage,
  selectInvoiceDownloadErrorMessage,
  selectInvoiceRowState,
} from '@/lib/organization-invoice-download';
import { ShareRemoteFileError } from '@/lib/share-remote-file';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: Object.assign(vi.fn(), { downloadFileAsync: vi.fn() }),
  Paths: { cache: 'file:///cache' },
}));

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
  it('maps download-failed to a retryable download message with no CTA', () => {
    expect(selectInvoiceDownloadErrorMessage('download-failed')).toBe(
      invoiceDownloadFailedMessage()
    );
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
});

describe('getInvoiceDownloadErrorMessage', () => {
  it('reads the discriminable reason from ShareRemoteFileError', () => {
    expect(getInvoiceDownloadErrorMessage(new ShareRemoteFileError('sharing-unavailable'))).toBe(
      invoiceSharingUnavailableMessage()
    );
    expect(getInvoiceDownloadErrorMessage(new ShareRemoteFileError('download-failed'))).toBe(
      invoiceDownloadFailedMessage()
    );
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

  it('does not double-append .pdf', () => {
    expect(getInvoicePdfFilename({ id: 'in_1', number: 'report.pdf', description: null })).toBe(
      'report.pdf'
    );
  });
});
