import { Directory, File } from 'expo-file-system';

import { artifactMirrorRoot } from './artifact-mirror-paths';
import {
  type ArtifactMirrorManifest,
  parseArtifactMirrorManifest,
  serializeArtifactMirrorManifest,
} from './artifact-mirror-manifest';

/**
 * The read-only mirror of the signed-in user's agent artifacts, laid out for
 * the platform file browser:
 *
 * ```
 * artifacts/
 *   manifest.json            the index, written last
 *   sessions/<sessionId>/<fileId>
 * ```
 *
 * A session folder exists even when the session has no files yet: that is the
 * empty-folder state a file browser shows. `manifest.json` is the only index —
 * a reader that fails to take it in simply shows the previous snapshot.
 */

/** Index at the mirror root. */
export const ARTIFACT_MIRROR_MANIFEST_FILE_NAME = 'manifest.json';

/** Folder holding one directory per session. */
export const ARTIFACT_MIRROR_SESSIONS_DIR_NAME = 'sessions';

/** Index name while it is being written, before the atomic rename. */
const MANIFEST_PART_FILE_NAME = `${ARTIFACT_MIRROR_MANIFEST_FILE_NAME}.part`;

/**
 * The mirror's index, or `null` when there is none (or it cannot be read).
 */
export function readArtifactMirror(): ArtifactMirrorManifest | null {
  const root = artifactMirrorRoot();
  if (root === null) {
    return null;
  }
  try {
    const manifestFile = new File(root, ARTIFACT_MIRROR_MANIFEST_FILE_NAME);
    if (!manifestFile.exists) {
      return null;
    }
    return parseArtifactMirrorManifest(manifestFile.textSync());
  } catch {
    return null;
  }
}

/**
 * The folder the mirror keeps for `sessionId`, whether or not it exists yet.
 * `null` when this platform has no browsable container.
 */
export function mirrorSessionDir(sessionId: string): Directory | null {
  const root = artifactMirrorRoot();
  if (root === null) {
    return null;
  }
  return new Directory(root, ARTIFACT_MIRROR_SESSIONS_DIR_NAME, sessionId);
}

/**
 * Bring the mirror in line with `manifest`: create a folder for every session,
 * prune the folders and files the snapshot dropped, then write the index last
 * so a reader never sees an index for files that are not there yet.
 *
 * Idempotent: applying the same snapshot twice leaves both the tree and the
 * index bytes untouched. Best effort: the mirror is derived data, so a
 * filesystem failure must never reach the sync that called it.
 */
export function applyArtifactSnapshot(manifest: ArtifactMirrorManifest): void {
  const root = artifactMirrorRoot();
  if (root === null) {
    return;
  }
  try {
    root.create({ idempotent: true, intermediates: true });
    const sessionsDirectory = new Directory(root, ARTIFACT_MIRROR_SESSIONS_DIR_NAME);
    sessionsDirectory.create({ idempotent: true, intermediates: true });

    const liveSessionIds = new Set<string>();
    for (const session of manifest.sessions) {
      const sessionDirectory = new Directory(sessionsDirectory, session.id);
      sessionDirectory.create({ idempotent: true, intermediates: true });
      liveSessionIds.add(session.id);
      pruneStaleEntries(sessionDirectory, new Set(session.files.map(file => file.id)));
    }

    pruneStaleEntries(sessionsDirectory, liveSessionIds);
    writeManifest(root, manifest);
  } catch {
    // Derived data: the next sync rebuilds it. Never throw into the caller.
  }
}

/**
 * Delete the whole mirror. Best effort: a missing or undeletable mirror never
 * throws, because sign-out must not block on cache hygiene.
 */
export function clearArtifactMirror(): void {
  try {
    const root = artifactMirrorRoot();
    if (root?.exists) {
      root.delete();
    }
  } catch {
    // Best-effort teardown; ignore delete failures.
  }
}

/**
 * Write the index through `manifest.json.part` and rename it into place, so a
 * reader holding `manifest.json` never sees a half-written document. An
 * unchanged index is left alone, keeping the bytes (and the mtime) identical.
 */
function writeManifest(root: Directory, manifest: ArtifactMirrorManifest): void {
  const bytes = serializeArtifactMirrorManifest(manifest);
  const target = new File(root, ARTIFACT_MIRROR_MANIFEST_FILE_NAME);
  if (target.exists && target.textSync() === bytes) {
    return;
  }

  const part = new File(root, MANIFEST_PART_FILE_NAME);
  part.write(bytes);
  part.moveSync(target, { overwrite: true });
}

function pruneStaleEntries(directory: Directory, liveNames: ReadonlySet<string>): void {
  if (!directory.exists) {
    return;
  }
  for (const entry of directory.list()) {
    if (!liveNames.has(entry.name)) {
      entry.delete();
    }
  }
}
