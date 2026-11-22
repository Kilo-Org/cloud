import { i18n } from '@/i18n';
import { getShareFailureKind, shareRemoteFile } from '@/lib/share-remote-file';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';

const DATA_EXPORT_CACHE_DIRECTORY = 'data-exports';

/** The name the export worker gives the artifact it serves. */
const DATA_EXPORT_FILENAME = 'kilo-data-export.jsonl.gz';

/**
 * Copy for a failed export download. A retryable failure is answered by taking
 * the artifact again; `sharing-unavailable` means the device has no share
 * sheet, and `file-unavailable` means the export the server holds is gone.
 * Neither is something the reader can fix from this screen.
 */
export function getDataExportFailureMessage(error: unknown): string {
  const kind = getShareFailureKind(error);
  switch (kind) {
    case 'sharing-unavailable': {
      return i18n.t('organization.invoices.sharingUnavailable');
    }
    case 'file-unavailable': {
      return i18n.t('common.fileUnavailable');
    }
    case 'retry':
    case 'general': {
      return i18n.t('profile.dataExport.downloadFailed');
    }
    default: {
      return assertSurfaceFailureHandled(kind);
    }
  }
}

/**
 * Downloads the signed artifact URL and hands it to the platform share sheet.
 *
 * The URL is a single-use capability, so it is fetched and cached under this
 * export's own key and never kept in state, written to a log, or shown.
 */
export async function shareDataExport({
  downloadUrl,
  exportId,
}: {
  downloadUrl: string;
  exportId: string;
}): Promise<void> {
  await shareRemoteFile({
    url: downloadUrl,
    cacheDirectoryName: DATA_EXPORT_CACHE_DIRECTORY,
    cacheKey: exportId,
    filename: DATA_EXPORT_FILENAME,
  });
}
