/* eslint-disable max-lines -- one cohesive suite for the browse contract: the Swift schema/layout extraction, the mirror fixture it reads back, and the list/open/empty assertions are one harness */
// eslint-disable-next-line import/no-nodejs-modules -- simulator substitute, runs in node, never bundled into the app
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- simulator substitute, runs in node, never bundled into the app
import { tmpdir } from 'node:os';
// eslint-disable-next-line import/no-nodejs-modules -- simulator substitute, runs in node, never bundled into the app
import { join, sep } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- simulator substitute, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_MIRROR_MANIFEST_FILE_NAME,
  ARTIFACT_MIRROR_SESSIONS_DIR_NAME,
} from '@/lib/artifacts/artifact-mirror';
import {
  ARTIFACT_MIRROR_MANIFEST_VERSION,
  type ArtifactMirrorManifest,
  type ArtifactMirrorSession,
  safeArtifactDisplayName,
  safeArtifactSessionName,
  serializeArtifactMirrorManifest,
} from '@/lib/artifacts/artifact-mirror-manifest';
import {
  ARTIFACT_APP_GROUP_ID,
  ARTIFACT_MIRROR_DIR_NAME,
} from '@/lib/artifacts/artifact-mirror-paths';

// Browse proof for the iOS Files app location, at the boundary the two
// processes share: the app writes an app-group mirror and registers the
// `com.apple.fileprovider-nonui` domain; the Files app asks the extension, which
// reads that container and hands back items.
//
// The extension is Swift and needs Xcode and a simulator, which no host in this
// workflow has, so this suite drives the same walkthrough from the other side of
// the boundary: it runs the real mirror writer, then reads the bytes back the
// way the extension does — with the manifest schema, the layout constants and
// the item identifier grammar taken from `targets/ArtifactsFileProvider/
// ArtifactsFileProviderExtension.swift`, never copied here. A rename on either
// side of the boundary, in either language, fails this suite instead of a
// device walkthrough.
//
// Covered: the list step (a folder per agent session), the open step (the
// artifact's bytes behind an item), and the states a browse can meet — a
// location the app has not mirrored into yet, a session with no artifacts, and
// an agent-supplied title or name that cannot be a filename as written.

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  Paths: {},
}));

// This suite writes the app-group container itself, so nothing here calls the
// mirror root. `artifact-mirror-paths.ts` still reads `Platform.OS` at import
// time, and the extension only exists on iOS.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

// `artifact-mirror-manifest.ts` reaches `extensionForMime` through the tool-card
// image cache, which imports the share sheet.
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const TARGET_NAME = 'ArtifactsFileProvider';

function readMobileFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), 'utf8');
}

const extensionSource = readMobileFile(`targets/${TARGET_NAME}/${TARGET_NAME}Extension.swift`);

/** One `static let <name> = "<value>"` from the extension source. */
function swiftStringConstant(name: string): string {
  const value = new RegExp(String.raw`static let ${name} = "([^"]+)"`, 'u').exec(
    extensionSource
  )?.[1];
  if (!value) {
    throw new Error(`${TARGET_NAME}Extension.swift declares no static let ${name}`);
  }
  return value;
}

/** One `static let <name> = <digits>` from the extension source. */
function swiftNumberConstant(name: string): number {
  const value = new RegExp(String.raw`static let ${name} = (\d+)`, 'u').exec(extensionSource)?.[1];
  if (!value) {
    throw new Error(`${TARGET_NAME}Extension.swift declares no static let ${name}`);
  }
  return Number(value);
}

/**
 * The `struct <name>: Decodable { ... }` body, matched by brace depth so a
 * struct nested inside another (`File` inside `Session` inside
 * `ArtifactManifest`) ends at its own closing brace.
 */
function swiftStructBody(name: string): string {
  const header = `struct ${name}: Decodable {`;
  const start = extensionSource.indexOf(header);
  if (start === -1) {
    throw new Error(`${TARGET_NAME}Extension.swift declares no "${header}"`);
  }
  let depth = 0;
  for (let index = start + header.length - 1; index < extensionSource.length; index += 1) {
    const character = extensionSource[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return extensionSource.slice(start + header.length, index);
      }
    }
  }
  throw new Error(`unterminated struct ${name}`);
}

/** Drop every nested `struct ...: Decodable { ... }` from a struct body. */
function withoutNestedStructs(body: string): string {
  let remaining = body;
  for (;;) {
    const nested = remaining.indexOf('struct ');
    if (nested === -1) {
      return remaining;
    }
    const open = remaining.indexOf('{', nested);
    let depth = 0;
    let close = remaining.length - 1;
    for (let index = open; index < remaining.length; index += 1) {
      if (remaining[index] === '{') {
        depth += 1;
      } else if (remaining[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    remaining = `${remaining.slice(0, nested)}${remaining.slice(close + 1)}`;
  }
}

/** The `let <field>: <SwiftType>` pairs a Swift `Decodable` struct requires. */
function swiftStructFields(name: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const match of withoutNestedStructs(swiftStructBody(name)).matchAll(
    /let (\w+): ([^\n]+)/gu
  )) {
    const [, field, swiftType] = match;
    if (field && swiftType) {
      fields.set(field, swiftType.trim());
    }
  }
  if (fields.size === 0) {
    throw new Error(`ArtifactManifest.${name} declares no stored fields`);
  }
  return fields;
}

const manifestStructs = new Map(
  ['File', 'Session', 'ArtifactManifest'].map(name => [name, swiftStructFields(name)])
);

/** What the extension reads, and the identifier grammar it parses back. */
const swiftContract = {
  appGroupIdentifier: swiftStringConstant('appGroupIdentifier'),
  directoryName: swiftStringConstant('directoryName'),
  filePrefix: swiftStringConstant('filePrefix'),
  manifestFileName: swiftStringConstant('manifestFileName'),
  sessionPrefix: swiftStringConstant('sessionPrefix'),
  sessionsDirectoryName: swiftStringConstant('sessionsDirectoryName'),
  supportedManifestVersion: swiftNumberConstant('supportedManifestVersion'),
};

type Decoded = { ok: true; value: unknown } | { ok: false; reason: string };

/** `JSON.parse` as a value the extension's decoder can reject. */
function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

const isDecodedObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decode one value the way the extension's `JSONDecoder` does against its
 * `ArtifactManifest` structs: every declared field must be present with the
 * declared type, and unknown keys are ignored.
 */
function decodeSwiftValue(swiftType: string, value: unknown): Decoded {
  if (value === undefined) {
    return { ok: false, reason: 'missing' };
  }
  if (swiftType === 'String') {
    return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'not a String' };
  }
  if (swiftType === 'Int') {
    return Number.isInteger(value) ? { ok: true, value } : { ok: false, reason: 'not an Int' };
  }
  const elementType = /^\[(\w+)\]$/u.exec(swiftType)?.[1];
  if (elementType) {
    if (!Array.isArray(value)) {
      return { ok: false, reason: 'not an array' };
    }
    for (const element of value) {
      const decoded = decodeSwiftStruct(elementType, element);
      if (!decoded.ok) {
        return decoded;
      }
    }
    return { ok: true, value };
  }
  return decodeSwiftStruct(swiftType, value);
}

function decodeSwiftStruct(name: string, value: unknown): Decoded {
  const fields = manifestStructs.get(name);
  if (!fields) {
    return { ok: false, reason: `the extension declares no struct ${name}` };
  }
  if (!isDecodedObject(value)) {
    return { ok: false, reason: `${name} is not an object` };
  }
  for (const [field, swiftType] of fields) {
    const decoded = decodeSwiftValue(swiftType, value[field]);
    if (!decoded.ok) {
      return { ok: false, reason: `${name}.${field} ${decoded.reason}` };
    }
  }
  return { ok: true, value };
}

type ExtensionFile = { id: string; name: string; mime: string; size: number };
type ExtensionSession = { id: string; title: string; files: ExtensionFile[] };
type ExtensionManifest = { version: number; sessions: ExtensionSession[] };

/**
 * `ArtifactMirror.manifest()`: an absent, undecodable or unknown-version index
 * reads as absent, so the location shows nothing rather than failing.
 */
function readMirrorAsExtension(raw: string | null): ExtensionManifest | null {
  if (raw === null) {
    return null;
  }
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    return null;
  }
  const decoded = decodeSwiftStruct('ArtifactManifest', parsed.value);
  if (!decoded.ok) {
    return null;
  }
  const manifest = decoded.value as ExtensionManifest;
  return manifest.version === swiftContract.supportedManifestVersion ? manifest : null;
}

/** One item the Files app receives from an enumeration. */
type FilesAppItem = {
  /** `identifier.rawValue`, built with the prefixes the extension parses back. */
  identifier: string;
  /** `parentItemIdentifier.rawValue`. */
  parent: string;
  filename: string;
  isDirectory: boolean;
  contentType: string;
};

/** `NSFileProviderItemIdentifier.rootContainer`. */
const ROOT_CONTAINER = 'rootContainer';

/** `ArtifactMirror.items(in: .root)`: one folder per session. */
function enumerateRoot(manifest: ExtensionManifest): FilesAppItem[] {
  return manifest.sessions.map(session => ({
    identifier: `${swiftContract.sessionPrefix}${session.id}`,
    parent: ROOT_CONTAINER,
    // Taken as written: `ArtifactItem(session:)` uses the manifest label, which
    // is only a legal filename because the app sanitized the title.
    filename: session.title,
    isDirectory: true,
    contentType: 'folder',
  }));
}

/** `ArtifactMirror.items(in: .session)`: one item per mirrored artifact. */
function enumerateSession(manifest: ExtensionManifest, sessionId: string): FilesAppItem[] {
  const session = manifest.sessions.find(candidate => candidate.id === sessionId);
  return (session?.files ?? []).map(file => ({
    identifier: `${swiftContract.filePrefix}${sessionId}/${file.id}`,
    parent: `${swiftContract.sessionPrefix}${sessionId}`,
    filename: file.name,
    isDirectory: false,
    contentType: file.mime,
  }));
}

/**
 * `ArtifactMirror.fileURL(sessionId:fileId:)`: `<app group>/<mirror>/
 * sessions/<sessionId>/<fileId>`, with a file id spanning several segments.
 */
function extensionFileURL(appGroupContainer: string, sessionId: string, fileId: string): string {
  return join(
    appGroupContainer,
    swiftContract.directoryName,
    swiftContract.sessionsDirectoryName,
    sessionId,
    ...fileId.split('/')
  );
}

/** The file id an item identifier carries, as the extension parses it back. */
function fileIdOf(item: FilesAppItem, sessionId: string): string {
  return item.identifier.slice(`${swiftContract.filePrefix}${sessionId}/`.length);
}

/** `NSFileProviderItem.filename` requires one non-empty path component. */
function isSinglePathComponent(filename: string): boolean {
  return filename !== '' && filename !== '.' && filename !== '..' && !filename.includes('/');
}

// One app-group container for the suite, written the way the app writes it:
// `artifacts/manifest.json` plus `artifacts/sessions/<sessionId>/<fileId>`.
const containerRoot = mkdtempSync(join(tmpdir(), 'artifacts-file-provider-'));
const mirrorRoot = join(containerRoot, ARTIFACT_MIRROR_DIR_NAME);
const sessionsRoot = join(mirrorRoot, ARTIFACT_MIRROR_SESSIONS_DIR_NAME);

afterAll(() => {
  rmSync(containerRoot, { force: true, recursive: true });
});

/** One agent session as the crawl hands it to the mirror: raw, unsanitized. */
type CrawledSession = {
  id: string;
  title: string | null;
  updatedAt: string;
  artifacts: { id: string; filename: string; mime: string; bytes: string }[];
};

const CRAWLED_SESSIONS: CrawledSession[] = [
  {
    id: 'sess_01HZ',
    title: 'Fix the login redirect',
    updatedAt: '2026-09-01T10:00:00.000Z',
    artifacts: [
      { id: 'part_a1', filename: 'summary.md', mime: 'text/markdown', bytes: '# Redirect\n' },
      { id: 'part_a2', filename: 'shot.png', mime: 'image/png', bytes: 'PNG-bytes' },
    ],
  },
  {
    // Free text from the database: a path separator and no usable basename.
    id: 'sess_02AB',
    title: '../../etc/passwd',
    updatedAt: '2026-09-02T10:00:00.000Z',
    artifacts: [
      // An agent-supplied name carrying a Windows separator.
      { id: 'att-0', filename: 'dir\\report.csv', mime: 'text/csv', bytes: 'a,b\n' },
    ],
  },
  {
    // A session folder with nothing in it is an empty folder, not an error.
    id: 'sess_03CD',
    title: null,
    updatedAt: '2026-09-03T10:00:00.000Z',
    artifacts: [],
  },
];

/**
 * The snapshot the app mirrors: labels run through the same sanitizers the crawl
 * uses, bytes written under the opaque ids. Returns the manifest it wrote.
 */
function writeMirror(sessions: CrawledSession[]): ArtifactMirrorManifest {
  const mirrorSessions: ArtifactMirrorSession[] = sessions.map(session => {
    const sessionDirectory = join(sessionsRoot, session.id);
    mkdirSync(sessionDirectory, { recursive: true });
    return {
      id: session.id,
      title: safeArtifactSessionName({ id: session.id, title: session.title }),
      updatedAt: session.updatedAt,
      files: session.artifacts.map(artifact => {
        writeFileSync(join(sessionDirectory, artifact.id), artifact.bytes);
        return {
          id: artifact.id,
          name: safeArtifactDisplayName({
            id: artifact.id,
            name: artifact.filename,
            mime: artifact.mime,
          }),
          mime: artifact.mime,
          size: new TextEncoder().encode(artifact.bytes).byteLength,
        };
      }),
    };
  });

  const manifest: ArtifactMirrorManifest = {
    version: ARTIFACT_MIRROR_MANIFEST_VERSION,
    updatedAt: '2026-09-03T11:00:00.000Z',
    sessions: mirrorSessions,
  };
  mkdirSync(mirrorRoot, { recursive: true });
  // `applyArtifactSnapshot` writes the index last, through `.part` + rename, so a
  // reader holding it never sees an index for files that are not there yet.
  writeFileSync(
    join(mirrorRoot, ARTIFACT_MIRROR_MANIFEST_FILE_NAME),
    serializeArtifactMirrorManifest(manifest)
  );
  return manifest;
}

/** Mirror the fixture and read it back the way the extension does. */
function mirroredAsExtension(): { mirrored: ArtifactMirrorManifest; manifest: ExtensionManifest } {
  const mirrored = writeMirror(CRAWLED_SESSIONS);
  const manifest = readMirrorAsExtension(
    readFileSync(join(mirrorRoot, swiftContract.manifestFileName), 'utf8')
  );
  expect(manifest).not.toBeNull();
  if (manifest === null) {
    throw new Error('the extension could not read the index the app wrote');
  }
  return { mirrored, manifest };
}

describe('artifacts File Provider browse (iOS)', () => {
  it('places the mirror where the extension looks for it', () => {
    // The agreement the location needs before anything can be listed: the
    // app-group id the mirror writes through, the folder layout and the index
    // name. Every value below comes from the extension source, so a rename in
    // `artifact-mirror*.ts` fails here.
    expect(swiftContract.appGroupIdentifier).toBe(ARTIFACT_APP_GROUP_ID);
    expect(swiftContract.directoryName).toBe(ARTIFACT_MIRROR_DIR_NAME);
    expect(swiftContract.sessionsDirectoryName).toBe(ARTIFACT_MIRROR_SESSIONS_DIR_NAME);
    expect(swiftContract.manifestFileName).toBe(ARTIFACT_MIRROR_MANIFEST_FILE_NAME);
    expect(swiftContract.supportedManifestVersion).toBe(ARTIFACT_MIRROR_MANIFEST_VERSION);

    // The extension can only reach the container its entitlement names: a group
    // that differs from the app's own is a location that stays empty.
    const entitlements = readMobileFile(`targets/${TARGET_NAME}/${TARGET_NAME}.entitlements`);
    const infoPlist = readMobileFile(`targets/${TARGET_NAME}/Info.plist`);
    expect(entitlements).toContain(`<string>${swiftContract.appGroupIdentifier}</string>`);
    expect(infoPlist).toContain(`<string>${swiftContract.appGroupIdentifier}</string>`);
  });

  it('accepts the index the app writes, and reads anything else as absent', () => {
    const { manifest } = mirroredAsExtension();
    expect(manifest.sessions.map(session => session.id)).toEqual(
      CRAWLED_SESSIONS.map(session => session.id)
    );

    // A reader meeting anything else shows nothing, never a broken location.
    expect(readMirrorAsExtension(null)).toBeNull();
    expect(readMirrorAsExtension('{ not json')).toBeNull();
    expect(readMirrorAsExtension(JSON.stringify({ version: 1, sessions: 'nope' }))).toBeNull();
    expect(readMirrorAsExtension(JSON.stringify({ version: 1 }))).toBeNull();

    // The version gate: a future index reads as absent, not as garbage.
    const futureVersion = JSON.parse(
      readFileSync(join(mirrorRoot, swiftContract.manifestFileName), 'utf8')
    ) as Record<string, unknown>;
    futureVersion.version = ARTIFACT_MIRROR_MANIFEST_VERSION + 1;
    expect(readMirrorAsExtension(JSON.stringify(futureVersion))).toBeNull();
  });

  it('lists one folder per session, labelled as the app sanitized it', () => {
    const { mirrored, manifest } = mirroredAsExtension();

    const items = enumerateRoot(manifest);
    expect(items).toHaveLength(CRAWLED_SESSIONS.length);
    for (const item of items) {
      // The extension takes the manifest label as the filename as written, so
      // the app's label has to survive that.
      expect(isSinglePathComponent(item.filename)).toBe(true);
      expect(item.isDirectory).toBe(true);
      expect(item.parent).toBe(ROOT_CONTAINER);
    }
    expect(items.map(item => item.filename)).toEqual(
      mirrored.sessions.map(session => session.title)
    );

    // The hostile title is not what the Files app is handed.
    const hostile = items.find(item => item.identifier.endsWith('sess_02AB'));
    expect(hostile?.filename).toBe('passwd');
  });

  it("lists each session's artifacts and opens their bytes", () => {
    const { mirrored, manifest } = mirroredAsExtension();

    for (const session of CRAWLED_SESSIONS) {
      const items = enumerateSession(manifest, session.id);
      expect(items).toHaveLength(session.artifacts.length);

      const sessionDirectory = join(mirrorRoot, swiftContract.sessionsDirectoryName, session.id);
      for (const [index, item] of items.entries()) {
        const artifact = session.artifacts[index];
        expect(artifact).toBeDefined();
        expect(isSinglePathComponent(item.filename)).toBe(true);
        expect(item.isDirectory).toBe(false);
        expect(item.parent).toBe(`${swiftContract.sessionPrefix}${session.id}`);
        // The MIME the app recorded is what `UTType(mimeType:)` sees.
        expect(item.contentType).toBe(artifact?.mime);

        // The manifest the app wrote is the name the Files app shows.
        const mirroredFile = mirrored.sessions
          .find(candidate => candidate.id === session.id)
          ?.files.at(index);
        expect(item.filename).toBe(mirroredFile?.name);

        // The open: the path the extension resolves holds the artifact's bytes.
        const resolved = extensionFileURL(containerRoot, session.id, fileIdOf(item, session.id));
        expect(resolved.startsWith(`${sessionDirectory}${sep}`)).toBe(true);
        expect(readFileSync(resolved, 'utf8')).toBe(artifact?.bytes);
      }
    }

    // The Windows-separator name survives as one component, like Android shows.
    expect(enumerateSession(manifest, 'sess_02AB')[0]?.filename).toBe('report.csv');
  });

  it('shows an empty location until the app has mirrored something', () => {
    // Signed out, or a first run: there is no index at all, so the extension
    // reads no sessions and the root enumerates an empty list.
    expect(readMirrorAsExtension(null)).toBeNull();

    // A mirrored index with no sessions is the same empty location.
    const emptyIndex = serializeArtifactMirrorManifest({
      version: ARTIFACT_MIRROR_MANIFEST_VERSION,
      updatedAt: '2026-09-03T11:00:00.000Z',
      sessions: [],
    });
    const emptyManifest = readMirrorAsExtension(emptyIndex);
    expect(emptyManifest).not.toBeNull();
    expect(emptyManifest === null ? [] : enumerateRoot(emptyManifest)).toEqual([]);

    // And a session that produced no artifacts is an empty folder, not an error.
    const { manifest } = mirroredAsExtension();
    expect(enumerateSession(manifest, 'sess_03CD')).toEqual([]);
  });

  it('keeps a mirrored artifact inside its own session folder', () => {
    const { manifest } = mirroredAsExtension();
    // Ids come from stored session history, so the extension validates them
    // before they become a path. Every id the app actually writes resolves to a
    // path below the session folder it belongs to, which is what keeps an
    // agent-supplied id from walking out of the location.
    for (const session of manifest.sessions) {
      const sessionDirectory = join(mirrorRoot, swiftContract.sessionsDirectoryName, session.id);
      for (const file of session.files) {
        const resolved = extensionFileURL(containerRoot, session.id, file.id);
        expect(resolved.startsWith(`${sessionDirectory}${sep}`)).toBe(true);
      }
      expect(
        enumerateSession(manifest, session.id).every(item =>
          item.identifier.startsWith(`${swiftContract.filePrefix}${session.id}/`)
        )
      ).toBe(true);
    }
  });
});
