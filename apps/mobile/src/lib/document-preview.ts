import { Directory, File, Paths } from 'expo-file-system';

import { stripDataUrlBase64Prefix } from '@/components/agents/tool-card-image-cache';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  downloadRemoteFile,
  getSafeCacheFilename,
  type MaterializedRemoteFile,
} from '@/lib/share-remote-file';
import { registerTempFile } from '@/lib/temp-file-registry';

/** Cache directory shared with the session file-part text and share copies. */
const CACHE_DIR_NAME = 'session-file-parts';

/**
 * Canonical extension per document MIME this app previews natively. Quick Look
 * resolves a file's type from its extension, so a copy whose name has no usable
 * extension is written under the canonical one. Android matches a viewer by the
 * MIME handed to the preview call.
 *
 * Text stays out on purpose: a text part keeps its in-app text preview, and
 * Markdown keeps its rendered preview.
 */
const DOCUMENT_EXTENSION_BY_MIME = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/epub+zip': 'epub',
} as const;

type DocumentMime = keyof typeof DOCUMENT_EXTENSION_BY_MIME;

function isDocumentMime(mime: string): mime is DocumentMime {
  // An own-property check, because `in` also matches inherited names such as
  // `constructor`, which are not document MIME types.
  return Object.hasOwn(DOCUMENT_EXTENSION_BY_MIME, mime);
}

/** Part or chip ids whose download or preview is running. A repeated tap joins
 *  nothing and starts nothing. */
const inFlight = new Set<string>();

type DocumentPreviewTarget = {
  /** MIME handed to `canPreview` and `preview`; Android matches a viewer by it. */
  mimeType: string;
  /** Canonical extension for the preview copy. */
  extension: string;
};

type DocumentPreviewOutcome = 'opened' | 'unavailable' | 'failed' | 'account-changed' | 'busy';

/** The document preview target for a MIME, or null when the file keeps its text
 *  and share choices only. Media and text types return null. */
export function getDocumentPreviewTarget(mime: string | undefined): DocumentPreviewTarget | null {
  const base = mime?.split(';')[0]?.trim().toLowerCase();
  if (base === undefined || base === '' || !isDocumentMime(base)) {
    return null;
  }
  return { mimeType: base, extension: DOCUMENT_EXTENSION_BY_MIME[base] };
}

/**
 * Preview a session attachment through the platform viewer. A `file://` copy is
 * presented as-is; `data:` and `http(s)` copies are materialized into the cache
 * first, kept for the TTL reap, and deleted when the viewer cannot present
 * them.
 */
export function previewRemoteDocument(input: {
  key: string;
  url: string;
  mimeType: string;
  filename?: string;
}): Promise<DocumentPreviewOutcome> {
  return withPreviewLease(input.key, () => openRemoteDocument(input));
}

/**
 * Preview a file the composer already owns. The chip keeps its file, so neither
 * a presented nor a failed preview deletes it.
 */
export function previewLocalDocument(input: {
  key: string;
  uri: string;
  mimeType: string;
  filename?: string;
}): Promise<DocumentPreviewOutcome> {
  return withPreviewLease(input.key, () => {
    const target = getDocumentPreviewTarget(input.mimeType);
    if (target === null) {
      return Promise.resolve<DocumentPreviewOutcome>('unavailable');
    }
    return presentDocumentPreview({
      uri: input.uri,
      target,
      title: input.filename,
      cacheName: previewCacheFilename({
        key: input.key,
        filename: input.filename,
        target,
      }),
      owned: undefined,
      epoch: currentAuthEpoch(),
    });
  });
}

async function openRemoteDocument({
  key,
  url,
  mimeType,
  filename,
}: {
  key: string;
  url: string;
  mimeType: string;
  filename?: string;
}): Promise<DocumentPreviewOutcome> {
  const target = getDocumentPreviewTarget(mimeType);
  if (target === null) {
    return 'unavailable';
  }
  const epoch = currentAuthEpoch();
  const materialized = await materializePreviewCopy({ url, key, filename, target });
  if (materialized === null) {
    return 'failed';
  }
  // A download can outlast the account it started under; the copy belongs to
  // the previous owner and must never reach the viewer.
  if (!isCurrentAuthEpoch(epoch)) {
    materialized.owned?.delete();
    return 'account-changed';
  }
  return presentDocumentPreview({
    uri: materialized.uri,
    target,
    title: filename,
    cacheName: previewCacheFilename({ key, filename, target }),
    owned: materialized.owned,
    epoch,
  });
}

async function withPreviewLease(
  key: string,
  run: () => Promise<DocumentPreviewOutcome>
): Promise<DocumentPreviewOutcome> {
  if (inFlight.has(key)) {
    return 'busy';
  }
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** Materialize a preview copy and report the copy this call owns, or null when
 *  the copy could not be produced. */
async function materializePreviewCopy({
  url,
  key,
  filename,
  target,
}: {
  url: string;
  key: string;
  filename: string | undefined;
  target: DocumentPreviewTarget;
}): Promise<{ uri: string; owned: MaterializedRemoteFile | undefined } | null> {
  if (url.startsWith('file://')) {
    return { uri: url, owned: undefined };
  }
  try {
    const owned = url.startsWith('data:')
      ? await writeDataUrlToCache(url, { key, filename, target })
      : await downloadRemoteFile({
          url,
          cacheDirectoryName: CACHE_DIR_NAME,
          cacheFilename: previewCacheFilename({ key, filename, target }),
        });
    return { uri: owned.uri, owned };
  } catch {
    return null;
  }
}

async function presentDocumentPreview({
  uri,
  target,
  title,
  cacheName,
  owned,
  epoch,
}: {
  uri: string;
  target: DocumentPreviewTarget;
  title: string | undefined;
  cacheName: string;
  owned: MaterializedRemoteFile | undefined;
  epoch: number;
}): Promise<DocumentPreviewOutcome> {
  const source = preparePreviewSource(uri);
  if (source === null) {
    owned?.delete();
    return 'failed';
  }
  let file = source;
  let ownedCopy = owned;
  if (source.extension.toLowerCase() !== `.${target.extension}`) {
    const renamed = await withCanonicalExtension(source, cacheName);
    if (renamed === null) {
      owned?.delete();
      return 'failed';
    }
    file = renamed.file;
    ownedCopy = renamed.owned;
  }
  let previewable = false;
  try {
    previewable = await file.canPreview({ mimeType: target.mimeType });
  } catch {
    ownedCopy?.delete();
    return 'failed';
  }
  if (!isCurrentAuthEpoch(epoch)) {
    if (ownedCopy !== owned) {
      owned?.delete();
    }
    ownedCopy?.delete();
    return 'account-changed';
  }
  if (!previewable) {
    ownedCopy?.delete();
    return 'unavailable';
  }
  try {
    await file.preview({ mimeType: target.mimeType, title });
  } catch {
    // iOS rejects a second presentation, and Android can lose the viewer
    // between the check and the handoff: both leave the user with the retry
    // path instead of an unhandled rejection.
    ownedCopy?.delete();
    return 'failed';
  }
  // The viewer reads the copy after the handoff returns, so the TTL reap owns
  // it from here; deleting now would truncate that read.
  if (ownedCopy !== undefined) {
    registerTempFile(ownedCopy.uri);
  }
  return 'opened';
}

/**
 * The file to present, or null when the uri does not name a readable file. A
 * malformed or stale uri must not throw: both callers hand the outcome to a
 * toast, never to an unhandled rejection.
 */
function preparePreviewSource(uri: string): File | null {
  try {
    const file = new File(uri);
    return file.exists ? file : null;
  } catch {
    return null;
  }
}

/**
 * A copy under the canonical extension, because Quick Look resolves a file's
 * type from its name: an attachment named `summary`, or one with an extension
 * the platform does not know, is presented from a copy that carries the MIME's
 * extension. The source file stays untouched for its owner.
 */
async function withCanonicalExtension(
  source: File,
  cacheName: string
): Promise<{ file: File; owned: MaterializedRemoteFile } | null> {
  try {
    const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
    directory.create({ idempotent: true, intermediates: true });
    const destination = new File(directory, cacheName);
    await source.copy(destination, { overwrite: true });
    return {
      file: destination,
      owned: {
        uri: destination.uri,
        delete: () => {
          if (destination.exists) {
            destination.delete();
          }
        },
      },
    };
  } catch {
    return null;
  }
}

function previewCacheFilename({
  key,
  filename,
  target,
}: {
  key: string;
  filename: string | undefined;
  target: DocumentPreviewTarget;
}): string {
  const base = filename?.trim() ?? '';
  const stem = base.replace(/\.[^./\\]{1,16}$/, '').trim();
  return getSafeCacheFilename({
    id: key,
    filename: `${stem === '' ? 'attachment' : stem}.${target.extension}`,
  });
}

async function writeDataUrlToCache(
  url: string,
  input: { key: string; filename: string | undefined; target: DocumentPreviewTarget }
): Promise<MaterializedRemoteFile> {
  const payload = stripDataUrlBase64Prefix(url, input.target.mimeType);
  if (payload === undefined) {
    throw new Error('decode-failed');
  }
  const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, previewCacheFilename(input));
  await file.write(payload, { encoding: 'base64' });
  return {
    uri: file.uri,
    delete: () => {
      if (file.exists) {
        file.delete();
      }
    },
  };
}
