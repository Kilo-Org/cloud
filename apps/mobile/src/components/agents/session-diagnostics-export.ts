import { Directory, File, Paths } from 'expo-file-system';

import { getSafeCacheFilename, shareLocalFile } from '@/lib/share-remote-file';
import { registerTempFile } from '@/lib/temp-file-registry';

/** The diagnostics exports share one cache directory, reaped by their TTL. */
const DIAGNOSTICS_CACHE_DIR = 'session-diagnostics';

/** The document the export procedure built, in the shape it declares. */
export type DiagnosticsDocument = {
  readonly fileName: string;
  readonly contentType: 'application/json' | 'text/csv';
  readonly content: string;
};

/**
 * Hands one exported diagnostics document to the platform share sheet, which is
 * the phone's save-or-send surface where the web uses a download.
 *
 * This module is imported at the press, never at the screen's load: it reaches
 * the native file system and the share sheet, which a node test environment
 * cannot load, and a session screen must stay mountable there.
 *
 * The cache copy is registered for the TTL reap rather than deleted after the
 * share: `shareAsync` resolves when the sheet closes, and on Android the
 * receiving app reads a lazily-resolved `content://` uri afterwards.
 */
export async function shareDiagnosticsDocument(
  document: DiagnosticsDocument,
  cacheScope: string
): Promise<void> {
  const directory = new Directory(Paths.cache, DIAGNOSTICS_CACHE_DIR);
  directory.create({ idempotent: true, intermediates: true });
  // The cache name is scoped by the session, so two sessions' exports never
  // share a file and the server's own name stays readable as the tail.
  const target = new File(
    directory,
    getSafeCacheFilename({ id: cacheScope, filename: document.fileName })
  );
  await target.write(document.content);
  registerTempFile(target.uri);
  await shareLocalFile(target.uri, { mimeType: document.contentType });
}
