/**
 * The one answer to what a filesystem entry leads to.
 *
 * Two audits ask the same question about a path they read from a directory
 * listing: does it name a regular file, or something else. They ask it for
 * different reasons — the catalog readers decide whether an entry is a locale
 * they can read, the source walk decides whether a candidate has source to
 * parse — so each keeps its own policy for a path it cannot inspect, and only
 * the inspection itself is shared here. One stat policy in one place means the
 * two cannot drift apart on which entries count as files.
 */
import { statSync } from 'node:fs';

/**
 * What the entry at `path` leads to: 'file' when it is a regular file, 'other'
 * when it exists but is not one, 'unreadable' when no stat can be obtained.
 *
 * The stat follows symlinks, so a link to a regular file is a 'file' and a link
 * to a directory is 'other'. `throwIfNoEntry: false` makes a link with no
 * target report no stat instead of throwing, so a dangling link is
 * 'unreadable' rather than a crash. A stat the filesystem refuses for another
 * reason — a pair of links that point at each other fails with `ELOOP`, which
 * `throwIfNoEntry` does not cover — lands in the same catch and is 'unreadable'
 * too.
 *
 * Each caller decides for itself what 'unreadable' means: a catalog reader may
 * keep the entry so its own later read reports the problem, while a source walk
 * leaves it out rather than hand an audit a file nobody can read.
 */
export function regularFileState(path) {
  let target;
  try {
    target = statSync(path, { throwIfNoEntry: false });
  } catch {
    return 'unreadable';
  }
  if (target === undefined) {
    return 'unreadable';
  }
  return target.isFile() ? 'file' : 'other';
}
