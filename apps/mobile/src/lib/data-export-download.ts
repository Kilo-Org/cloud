import { i18n } from '@/i18n';
import { getShareRemoteFileReason, shareRemoteFile } from '@/lib/share-remote-file';

const DATA_EXPORT_CACHE_DIRECTORY = 'data-exports';

/** The name the export worker gives the artifact it serves. */
const DATA_EXPORT_FILENAME = 'kilo-data-export.jsonl.gz';

/**
 * Copy for a failed export download. A download failure is retryable by taking
 * the code again; `sharing-unavailable` means the device has no share sheet,
 * which the reader cannot fix from this screen.
 */
export function getDataExportFailureMessage(error: unknown): string {
  return getShareRemoteFileReason(error) === 'sharing-unavailable'
    ? i18n.t('organization.invoices.sharingUnavailable')
    : i18n.t('profile.dataExport.downloadFailed');
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
