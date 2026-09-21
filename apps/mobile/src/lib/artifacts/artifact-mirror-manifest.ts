import * as z from 'zod';

import { extensionForMime } from '@/components/agents/tool-card-image-cache';
import { truncateUtf8, utf8ByteLength } from '@/lib/utf8-utils';

/**
 * The mirror's index.
 *
 * `manifest.json` is the only place a file's *display* name exists: on disk the
 * bytes are `sessions/<sessionId>/<fileId>`, both opaque ids. That is what
 * keeps an agent-supplied name from escaping its session folder, and it means a
 * session rename never moves a byte.
 */

/** Bumped when the manifest shape changes; an unknown version reads as absent. */
export const ARTIFACT_MIRROR_MANIFEST_VERSION = 1;

/** A display name may not exceed this many UTF-8 bytes. */
const MAX_ARTIFACT_DISPLAY_NAME_BYTES = 200;

/** Stem used when an artifact has no usable name at all. */
const DISPLAY_NAME_FALLBACK_STEM = 'artifact';

/** Extension used when the MIME type yields no usable extension. */
const DISPLAY_NAME_FALLBACK_EXTENSION = 'bin';

/** Folder label used when neither a session's title nor its id yields a name. */
const SESSION_NAME_FALLBACK = 'Session';

// Control characters: C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls
// (0x80-0x9F). Written in decimal because oxfmt normalizes hex literals to
// lowercase, which `unicorn/number-literal-case` rejects.
const C0_CONTROL_CODE_POINT_MAX = 31;
const DELETE_CODE_POINT = 127;
const C1_CONTROL_CODE_POINT_MIN = 128;
const C1_CONTROL_CODE_POINT_MAX = 159;

const artifactMirrorFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});

const artifactMirrorSessionSchema = z.object({
  id: z.string(),
  // A display label, not the raw session title: the mirror writes
  // `safeArtifactSessionName`'s output here, which is what the iOS File
  // Provider and Android DocumentsProvider read back.
  title: z.string(),
  updatedAt: z.string(),
  files: z.array(artifactMirrorFileSchema),
});

const artifactMirrorManifestSchema = z.object({
  version: z.literal(ARTIFACT_MIRROR_MANIFEST_VERSION),
  updatedAt: z.string(),
  sessions: z.array(artifactMirrorSessionSchema),
});

export type ArtifactMirrorFile = z.infer<typeof artifactMirrorFileSchema>;
export type ArtifactMirrorSession = z.infer<typeof artifactMirrorSessionSchema>;
export type ArtifactMirrorManifest = z.infer<typeof artifactMirrorManifestSchema>;

/**
 * Parse an on-disk manifest. An absent, unparseable, or invalid index reads as
 * absent: the mirror is derived data, so a bad index must never throw.
 */
export function parseArtifactMirrorManifest(raw: string | null): ArtifactMirrorManifest | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = artifactMirrorManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Serialize an index with a fixed key order, so an unchanged snapshot is
 * byte-identical and the mirror can skip rewriting `manifest.json`.
 */
export function serializeArtifactMirrorManifest(manifest: ArtifactMirrorManifest): string {
  return JSON.stringify({
    version: manifest.version,
    updatedAt: manifest.updatedAt,
    sessions: manifest.sessions.map(session => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      files: session.files.map(file => ({
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
      })),
    })),
  });
}

/**
 * Turn an agent-supplied name into a display name a file browser can show.
 *
 * Only the manifest ever holds this string (the on-disk name is the opaque file
 * id), but it still must not carry a path, a control character, or an unbounded
 * run of bytes. The extension is kept when the name has to be truncated, so the
 * browser can still map the file to an app.
 */
export function safeArtifactDisplayName({
  id,
  name,
  mime,
}: {
  id: string;
  name: string;
  mime: string;
}): string {
  const fromName = sanitizeArtifactName(name);
  if (fromName.length > 0) {
    return fromName;
  }
  const fromId = sanitizeArtifactName(`${id}.${extensionForMime(mime)}`);
  if (fromId.length > 0) {
    return fromId;
  }
  const extension = sanitizeArtifactName(extensionForMime(mime));
  return extension.length > 0
    ? `${DISPLAY_NAME_FALLBACK_STEM}.${extension}`
    : `${DISPLAY_NAME_FALLBACK_STEM}.${DISPLAY_NAME_FALLBACK_EXTENSION}`;
}

/**
 * The label a session folder shows in a file browser.
 *
 * A session title is free text from the database: nullable, unbounded, and able
 * to carry a path separator. Both `NSFileProviderItem.filename` (iOS) and
 * DocumentsProvider's `DISPLAY_NAME` (Android) require one non-empty path
 * component, so the title is sanitized exactly like an artifact name and falls
 * back to `Session <id>` when nothing survives, so both browsers show the same
 * folder.
 */
export function safeArtifactSessionName({
  id,
  title,
}: {
  id: string;
  title: string | null;
}): string {
  const fromTitle = sanitizeArtifactName(title ?? '');
  if (fromTitle.length > 0) {
    return fromTitle;
  }
  const safeId = sanitizeArtifactName(id);
  return boundArtifactDisplayName(safeId.length > 0 ? `Session ${safeId}` : SESSION_NAME_FALLBACK);
}

/**
 * Drop whole sessions, oldest `updatedAt` first, until the summed file sizes
 * fit `maxBytes`. The session entries stay — only their files leave — so an
 * evicted session shows up as an empty folder instead of disappearing from the
 * browser. The input is never mutated.
 */
export function selectSessionsWithinBudget(
  sessions: ArtifactMirrorSession[],
  maxBytes: number
): ArtifactMirrorSession[] {
  let remainingBytes = sessions.reduce((total, session) => total + sessionFileBytes(session), 0);
  if (remainingBytes <= maxBytes) {
    return [...sessions];
  }

  // Hermes lacks `toSorted()`; the mapped array is fresh, so sorting it in
  // place cannot reach the caller's snapshot.
  const indexedSessions = sessions.map((session, index) => ({
    index,
    updatedAt: session.updatedAt,
  }));
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes lacks toSorted()
  const oldestFirst = indexedSessions.sort(compareOldestFirst);

  const emptiedIndexes = new Set<number>();
  for (const { index } of oldestFirst) {
    if (remainingBytes <= maxBytes) {
      break;
    }
    const session = sessions[index];
    if (session) {
      remainingBytes -= sessionFileBytes(session);
      emptiedIndexes.add(index);
    }
  }

  return sessions.map((session, index) =>
    emptiedIndexes.has(index) ? { ...session, files: [] } : session
  );
}

function sessionFileBytes(session: ArtifactMirrorSession): number {
  return session.files.reduce((total, file) => total + file.size, 0);
}

function compareOldestFirst(
  a: { index: number; updatedAt: string },
  b: { index: number; updatedAt: string }
): number {
  if (a.updatedAt < b.updatedAt) {
    return -1;
  }
  if (a.updatedAt > b.updatedAt) {
    return 1;
  }
  // Equal timestamps keep the snapshot's order, so the choice is deterministic.
  return a.index - b.index;
}

function sanitizeArtifactName(raw: string): string {
  const basename = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);

  let withoutControls = '';
  for (const character of basename) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isControlCodePoint(codePoint)) {
      withoutControls += character;
    }
  }

  const collapsed = withoutControls.replaceAll(/\s+/gu, ' ').trim();
  if (collapsed.length === 0 || collapsed === '.' || collapsed === '..') {
    return '';
  }
  return boundArtifactDisplayName(collapsed);
}

function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= C0_CONTROL_CODE_POINT_MAX ||
    codePoint === DELETE_CODE_POINT ||
    (codePoint >= C1_CONTROL_CODE_POINT_MIN && codePoint <= C1_CONTROL_CODE_POINT_MAX)
  );
}

function boundArtifactDisplayName(name: string): string {
  if (utf8ByteLength(name) <= MAX_ARTIFACT_DISPLAY_NAME_BYTES) {
    return name;
  }

  const extensionStart = name.lastIndexOf('.');
  if (extensionStart > 0 && extensionStart < name.length - 1) {
    const extension = name.slice(extensionStart);
    const extensionBytes = utf8ByteLength(extension);
    if (extensionBytes < MAX_ARTIFACT_DISPLAY_NAME_BYTES) {
      const stem = name.slice(0, extensionStart);
      const truncatedStem = truncateUtf8(stem, MAX_ARTIFACT_DISPLAY_NAME_BYTES - extensionBytes);
      if (truncatedStem.length > 0) {
        return `${truncatedStem}${extension}`;
      }
    }
  }

  return truncateUtf8(name, MAX_ARTIFACT_DISPLAY_NAME_BYTES);
}
