/**
 * The transfer progress sink, split out of `gguf-downloads.ts` so the store keeps
 * the download's lifecycle and this module keeps what one byte report may change.
 */

import { type GgufStorage, STORAGE_HEADROOM_BYTES } from './gguf-records';
import { type GgufActiveDownload as Active, currentTransfer } from './gguf-transfers';

/** The byte counts a native transfer reports. */
type TransferProgress = { readonly bytesWritten: number; readonly totalBytes: number };

type ProgressReporterInput = {
  readonly storage: GgufStorage;
  /** The download the store currently owns; a report for another one is dropped. */
  readonly activeDownload: () => Active | undefined;
  readonly publish: () => void;
};

/**
 * Build the progress handler. A report is accepted only for the download that is
 * still active and still downloading, and a first stated length that does not fit
 * on the device ends the transfer rather than filling the disk.
 */
export function createProgressReporter(input: ProgressReporterInput) {
  return (download: () => Active | undefined) =>
    (progress: TransferProgress): void => {
      const current = download();
      if (
        current === undefined ||
        input.activeDownload() !== current ||
        current.phase !== 'downloading'
      ) {
        return;
      }
      // Bytes arriving after a resume mean the server accepted it.
      current.resuming = false;
      const { expected } = currentTransfer(current);
      const firstLength = current.total <= 0 && progress.totalBytes > 0;
      current.written = progress.bytesWritten;
      current.total = progress.totalBytes > 0 ? progress.totalBytes : (expected ?? 0);
      const room = input.storage.freeBytes();
      if (
        firstLength &&
        expected === undefined &&
        room < current.total - current.written + STORAGE_HEADROOM_BYTES
      ) {
        current.stop = 'space';
        current.task.cancel();
        return;
      }
      input.publish();
    };
}
