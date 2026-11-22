import { Directory, File } from 'expo-file-system';

import { captureTelemetry } from '@/lib/telemetry/error-sink';

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
 * Reports whether it changed the tree in a way the index bytes cannot show: a
 * directory it had to create, or an entry it pruned. The caller announces that
 * repair, because the index it builds from the same snapshot can be byte-for-byte
 * identical while the tree moved underneath it -- a session with no files
 * publishes an empty list, so a folder the platform file browser deleted is
 * re-created without the listing changing, and a crashed run's staging file is
 * pruned the same way. Without the report an open browser would keep showing the
 * deleted folder until something else happened to refresh it.
 *
 * Idempotent: applying the same snapshot twice leaves both the tree and the
 * index bytes untouched, and the second apply reports `false`. Best effort: the
 * mirror is derived data, so a filesystem failure must never reach the sync that
 * called it; a snapshot that stopped partway still moved the tree, and reports
 * `true` for it.
 */
export function applyArtifactSnapshot(manifest: ArtifactMirrorManifest): boolean {
  const root = artifactMirrorRoot();
  if (root === null) {
    return false;
  }
  try {
    let repaired = ensureDirectory(root);
    const sessionsDirectory = new Directory(root, ARTIFACT_MIRROR_SESSIONS_DIR_NAME);
    repaired = ensureDirectory(sessionsDirectory) || repaired;

    const liveSessionIds = new Set<string>();
    for (const session of manifest.sessions) {
      const sessionDirectory = new Directory(sessionsDirectory, session.id);
      repaired = ensureDirectory(sessionDirectory) || repaired;
      liveSessionIds.add(session.id);
      const pruned = pruneStaleEntries(
        sessionDirectory,
        new Set(session.files.map(file => file.id))
      );
      repaired = pruned || repaired;
    }

    repaired = pruneStaleEntries(sessionsDirectory, liveSessionIds) || repaired;
    writeManifest(root, manifest);
    return repaired;
  } catch {
    // Derived data: the next sync rebuilds it. Never throw into the caller, and
    // a partially applied snapshot is still a tree change to announce.
    return true;
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
  } catch (error) {
    captureTelemetry({
      error,
      level: 'warning',
      tags: { 'error.subsystem': 'artifact-mirror', 'error.operation': 'clear' },
    });
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
  part.writeSync(bytes);
  part.moveSync(target, { overwrite: true });
}

function pruneStaleEntries(directory: Directory, liveNames: ReadonlySet<string>): boolean {
  let pruned = false;
  try {
    if (!directory.exists) {
      return false;
    }
    for (const entry of directory.list()) {
      if (!liveNames.has(entry.name)) {
        try {
          entry.delete();
          pruned = true;
        } catch {
          // One entry the filesystem refuses to delete must not stop the index
          // write, so it stays for the next run.
        }
      }
    }
  } catch {
    // A directory the filesystem will not even list must not hold the index
    // back either: its entries stay for the next run.
  }
  return pruned;
}

/**
 * Create `directory` when it is missing, reporting whether this call was what
 * created it. The exists check is what turns the idempotent create into a repair
 * report: a directory that is already there moves nothing. `idempotent` stays on
 * for the race with another writer, where a create that finds the directory does
 * no harm -- over-reporting a repair only costs one extra refresh.
 */
function ensureDirectory(directory: Directory): boolean {
  if (directory.exists) {
    return false;
  }
  directory.create({ idempotent: true, intermediates: true });
  return true;
}
