import { describe, expect, it, vi } from 'vitest';

import type * as ShareRemoteFileModule from '@/lib/share-remote-file';

import { getDataExportFailureMessage, shareDataExport } from '@/lib/data-export-download';
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

const shareRemoteFile = vi.hoisted(() => vi.fn());

// Only the transfer is faked: the failure reason, its class, and the failure
// classification under test are the real ones.
vi.mock('@/lib/share-remote-file', async importOriginal => {
  const actual = await importOriginal<typeof ShareRemoteFileModule>();
  return { ...actual, shareRemoteFile };
});

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

describe('shareDataExport', () => {
  it('gives the export its own transfer budget, past the interactive share deadline', async () => {
    shareRemoteFile.mockResolvedValue(undefined);

    await shareDataExport({ downloadUrl: 'https://example.com/export', exportId: 'exp_1' });

    expect(shareRemoteFile).toHaveBeenCalledTimes(1);
    const [input] = shareRemoteFile.mock.calls[0] as [
      { deadlineMs?: number; url: string; cacheKey: string; filename: string },
    ];
    // The export has no server-side size cap, so a slow but progressing
    // transfer must outlast the 30 s interactive share budget (the module's
    // own `SHARE_DOWNLOAD_DEADLINE_MS`).
    expect(typeof input.deadlineMs).toBe('number');
    expect(input.deadlineMs).toBeGreaterThan(30_000);
    expect(input).toMatchObject({
      url: 'https://example.com/export',
      cacheDirectoryName: 'data-exports',
      cacheKey: 'exp_1',
      filename: 'kilo-data-export.jsonl.gz',
    });
  });
});
