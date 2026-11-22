import { describe, expect, it, vi } from 'vitest';

import { getDataExportFailureMessage } from '@/lib/data-export-download';
import { ShareRemoteFileError } from '@/lib/share-remote-file';
import { i18n } from '@/i18n';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  FileMode: { WriteOnly: 'w' },
  Paths: { cache: 'file:///cache' },
}));

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const downloadFailed = () => i18n.t('profile.dataExport.downloadFailed');
const sharingUnavailable = () => i18n.t('organization.invoices.sharingUnavailable');

describe('getDataExportFailureMessage', () => {
  it('keeps a retryable failure on the download-again copy', () => {
    for (const reason of ['download-timeout', 'download-network', 'download-failed'] as const) {
      expect(getDataExportFailureMessage(new ShareRemoteFileError(reason))).toBe(downloadFailed());
    }
  });

  it('keeps a re-signed or transient status on the download-again copy', () => {
    // 401/403 are a presigned link a later tap re-signs; 408/429/5xx are the
    // origin's own bad moment.
    for (const httpStatus of [401, 403, 408, 429, 500]) {
      expect(
        getDataExportFailureMessage(
          new ShareRemoteFileError('download-http-status', { httpStatus })
        )
      ).toBe(downloadFailed());
    }
  });

  it('says the device cannot share when the sheet is missing', () => {
    expect(getDataExportFailureMessage(new ShareRemoteFileError('sharing-unavailable'))).toBe(
      sharingUnavailable()
    );
  });

  it('says the file is gone for a definitive 4xx', () => {
    for (const httpStatus of [400, 404, 405, 409, 410]) {
      expect(
        getDataExportFailureMessage(
          new ShareRemoteFileError('download-http-status', { httpStatus })
        )
      ).toBe(i18n.t('common.fileUnavailable'));
    }
  });

  it('falls back to the download copy for an untyped error', () => {
    expect(getDataExportFailureMessage(new Error('boom'))).toBe(downloadFailed());
  });
});
