/* eslint-disable max-lines -- the atomic-index invariant lives in this suite's fake filesystem, and splitting the harness into a second file would duplicate it */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyArtifactSnapshot,
  ARTIFACT_MIRROR_MANIFEST_FILE_NAME,
  ARTIFACT_MIRROR_SESSIONS_DIR_NAME,
  clearArtifactMirror,
  mirrorSessionDir,
  readArtifactMirror,
} from '@/lib/artifacts/artifact-mirror';
import {
  ARTIFACT_MIRROR_MANIFEST_VERSION,
  type ArtifactMirrorManifest,
} from '@/lib/artifacts/artifact-mirror-manifest';
import {
  ARTIFACT_APP_GROUP_ID,
  ARTIFACT_MIRROR_DIR_NAME,
} from '@/lib/artifacts/artifact-mirror-paths';

const APP_GROUP_URI = 'file:///app-group';
const DOCUMENT_URI = 'file:///documents';
const MIRROR_ROOT = `${APP_GROUP_URI}/${ARTIFACT_MIRROR_DIR_NAME}`;
const SESSIONS_DIR = `${MIRROR_ROOT}/${ARTIFACT_MIRROR_SESSIONS_DIR_NAME}`;
const MANIFEST_URI = `${MIRROR_ROOT}/${ARTIFACT_MIRROR_MANIFEST_FILE_NAME}`;

/** How the mirror replaced the index, observed at the storage boundary. */
type IndexReplacement = {
  /** The document that became the index. */
  staged: string;
  /** What a reader at the index URI held while the replacement was staged. */
  previous: string | undefined;
  /** The operation-log position of the replacement. */
  operationIndex: number;
};

/** One node of the fake filesystem: a directory, or a file with its content. */
type FakeNode = { kind: 'directory' } | { kind: 'file'; content: string };

/**
 * In-memory stand-in for the expo-file-system classes. It keeps a real tree, so
 * the reconcile tests can assert on what exists after a sync and on the order
 * the mirror touched it. `vi.hoisted` runs before the module body, so every
 * value here is a literal.
 */
const fakeFs = vi.hoisted(() => {
  const nodes = new Map<string, FakeNode>();
  const operations: string[] = [];
  // The document the mirror must replace rather than write in place, and what
  // it did to it. A case seeds fixtures through `seedFile`, which bypasses the
  // guard; `beforeEach` arms the guard for the mirror's own writes.
  let protectedIndexUri: string | null = null;
  const directIndexWrites: string[] = [];
  const indexReplacements: IndexReplacement[] = [];
  const appGroup = { id: 'group.com.kilocode.kiloapp', uri: 'file:///app-group' };

  // eslint-disable-next-line unicorn/consistent-function-scoping -- vi.hoisted runs before module scope
  function parentOf(uri: string): string {
    return uri.slice(0, Math.max(0, uri.lastIndexOf('/')));
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- vi.hoisted runs before module scope
  function joinUri(...parts: unknown[]): string {
    let joined = '';
    for (const part of parts) {
      // A string is a URI; anything else is one of this mock's entries.
      const segment = typeof part === 'string' ? part : (part as { uri: string }).uri;
      if (segment !== '') {
        const rest = segment.replace(/^\/+/u, '');
        joined = joined === '' ? rest : `${joined.replace(/\/+$/u, '')}/${rest}`;
      }
    }
    return joined;
  }

  function createDirectory(
    uri: string,
    options: { idempotent?: boolean; intermediates?: boolean } = {}
  ): void {
    const existing = nodes.get(uri);
    if (existing) {
      if (existing.kind === 'directory' && options.idempotent === true) {
        return;
      }
      throw new Error(`already exists: ${uri}`);
    }
    const parent = parentOf(uri);
    if (parent !== '' && nodes.get(parent)?.kind !== 'directory') {
      if (options.intermediates !== true) {
        throw new Error(`missing parent: ${parent}`);
      }
      createDirectory(parent, { intermediates: true });
    }
    nodes.set(uri, { kind: 'directory' });
    operations.push(`create:${uri}`);
  }

  /** Put a file at `uri`, bypassing the in-place-write guard. */
  function writeNode(uri: string, content: string): void {
    const parent = parentOf(uri);
    if (parent !== '' && nodes.get(parent)?.kind !== 'directory') {
      throw new Error(`missing parent: ${parent}`);
    }
    nodes.set(uri, { kind: 'file', content });
    operations.push(`write:${uri}`);
  }

  function entryOf(uri: string) {
    return {
      uri,
      get name() {
        return uri.slice(uri.lastIndexOf('/') + 1);
      },
      get exists() {
        return nodes.has(uri);
      },
      create(options: { idempotent?: boolean; intermediates?: boolean } = {}) {
        createDirectory(uri, options);
      },
      list() {
        if (nodes.get(uri)?.kind !== 'directory') {
          throw new Error(`not a directory: ${uri}`);
        }
        const prefix = `${uri}/`;
        return [...nodes.keys()]
          .filter(child => child.startsWith(prefix) && !child.slice(prefix.length).includes('/'))
          .toSorted((a, b) => a.localeCompare(b))
          .map(child => entryOf(child));
      },
      writeSync(content: string) {
        if (uri === protectedIndexUri) {
          directIndexWrites.push(uri);
          throw new Error(`direct write to a protected document: ${uri}`);
        }
        writeNode(uri, content);
      },
      textSync() {
        const node = nodes.get(uri);
        if (node?.kind !== 'file') {
          throw new Error(`not a file: ${uri}`);
        }
        return node.content;
      },
      delete() {
        if (!nodes.has(uri)) {
          throw new Error(`missing: ${uri}`);
        }
        for (const child of nodes.keys()) {
          if (child === uri || child.startsWith(`${uri}/`)) {
            nodes.delete(child);
          }
        }
        operations.push(`delete:${uri}`);
      },
      moveSync(destination: { uri: string }, options: { overwrite?: boolean } = {}) {
        const node = nodes.get(uri);
        if (node?.kind !== 'file') {
          throw new Error(`not a file: ${uri}`);
        }
        if (nodes.has(destination.uri) && options.overwrite !== true) {
          throw new Error(`exists: ${destination.uri}`);
        }
        if (destination.uri === protectedIndexUri) {
          const target = nodes.get(destination.uri);
          indexReplacements.push({
            staged: node.content,
            previous: target?.kind === 'file' ? target.content : undefined,
            operationIndex: operations.length,
          });
        }
        nodes.delete(uri);
        nodes.set(destination.uri, node);
        operations.push(`move:${uri}->${destination.uri}`);
      },
    };
  }

  const Directory = vi.fn(function DirectoryMock(...parts: unknown[]) {
    return entryOf(joinUri(...parts));
  });
  const File = vi.fn(function FileMock(...parts: unknown[]) {
    return entryOf(joinUri(...parts));
  });

  const paths: { document: string; appleSharedContainers: Record<string, string> } = {
    document: 'file:///documents',
    appleSharedContainers: { [appGroup.id]: appGroup.uri },
  };

  return {
    Directory,
    File,
    Paths: paths,
    appGroup,
    operations,
    directIndexWrites,
    indexReplacements,
    setAppGroup: (available: boolean) => {
      paths.appleSharedContainers = available ? { [appGroup.id]: appGroup.uri } : {};
    },
    /** Name the document a case protects from in-place writes. */
    protectIndex: (uri: string) => {
      protectedIndexUri = uri;
    },
    has: (uri: string) => nodes.has(uri),
    readFile: (uri: string) => {
      const node = nodes.get(uri);
      return node?.kind === 'file' ? node.content : undefined;
    },
    seedFile: (uri: string, content: string) => {
      const parent = parentOf(uri);
      if (parent !== '') {
        createDirectory(parent, { idempotent: true, intermediates: true });
      }
      writeNode(uri, content);
    },
    /** Deep, order-independent snapshot of the whole tree. */
    snapshot: () =>
      [...nodes.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([uri, node]) => `${uri}|${node.kind === 'file' ? node.content : '<dir>'}`),
    reset: () => {
      nodes.clear();
      operations.length = 0;
      directIndexWrites.length = 0;
      indexReplacements.length = 0;
      // The guard outlives a reset: a case that resets mid-case keeps the
      // protection, so no apply can write the index in place unnoticed.
    },
  };
});

const reactNativeMock = vi.hoisted(() => ({ Platform: { OS: 'ios' } }));

vi.mock('expo-file-system', () => ({
  Directory: fakeFs.Directory,
  File: fakeFs.File,
  Paths: fakeFs.Paths,
}));

vi.mock('react-native', () => ({ Platform: reactNativeMock.Platform }));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const SNAPSHOT_TIME = '2026-01-01T00:00:00.000Z';

function snapshotOf(sessions: { id: string; files?: string[] }[] = []): ArtifactMirrorManifest {
  return {
    version: ARTIFACT_MIRROR_MANIFEST_VERSION,
    updatedAt: SNAPSHOT_TIME,
    sessions: sessions.map(session => ({
      id: session.id,
      title: `Session ${session.id}`,
      updatedAt: SNAPSHOT_TIME,
      files: (session.files ?? []).map(id => ({
        id,
        name: `${id}.txt`,
        mime: 'text/plain',
        size: 1,
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reactNativeMock.Platform.OS = 'ios';
  fakeFs.reset();
  fakeFs.setAppGroup(true);
  fakeFs.protectIndex(MANIFEST_URI);
});

describe('applyArtifactSnapshot', () => {
  it('writes into the platform container and keeps an empty session folder', () => {
    expect(fakeFs.appGroup.id).toBe(ARTIFACT_APP_GROUP_ID);

    applyArtifactSnapshot(snapshotOf([{ id: 's1' }]));

    expect(fakeFs.has(`${SESSIONS_DIR}/s1`)).toBe(true);
    expect(fakeFs.has(MANIFEST_URI)).toBe(true);
    expect(fakeFs.has(`${DOCUMENT_URI}/artifacts`)).toBe(false);

    reactNativeMock.Platform.OS = 'android';
    fakeFs.reset();
    applyArtifactSnapshot(snapshotOf([{ id: 's1' }]));

    expect(fakeFs.has(`${DOCUMENT_URI}/artifacts/sessions/s1`)).toBe(true);
    expect(fakeFs.has(MIRROR_ROOT)).toBe(false);
  });

  it('prunes a dropped session folder and a stale file in a live one', () => {
    fakeFs.seedFile(`${SESSIONS_DIR}/gone/stale.txt`, 'stale');
    fakeFs.seedFile(`${SESSIONS_DIR}/s1/stale.txt`, 'stale');
    fakeFs.seedFile(`${SESSIONS_DIR}/s1/keep`, 'bytes');

    applyArtifactSnapshot(snapshotOf([{ id: 's1', files: ['keep'] }]));

    expect(fakeFs.has(`${SESSIONS_DIR}/gone`)).toBe(false);
    expect(fakeFs.has(`${SESSIONS_DIR}/s1/stale.txt`)).toBe(false);
    expect(fakeFs.readFile(`${SESSIONS_DIR}/s1/keep`)).toBe('bytes');
  });

  it('publishes the index atomically, after the session folders it describes', () => {
    const first = snapshotOf([{ id: 's1', files: ['f1'] }]);
    const second = snapshotOf([{ id: 's1', files: ['f1'] }, { id: 's2' }]);

    applyArtifactSnapshot(first);
    applyArtifactSnapshot(second);

    // A reader at the index URI holds a complete document at every moment.
    expect(fakeFs.directIndexWrites).toEqual([]);
    expect(fakeFs.indexReplacements.map(({ staged, previous }) => [staged, previous])).toEqual([
      [JSON.stringify(first), undefined],
      [JSON.stringify(second), JSON.stringify(first)],
    ]);
    // The new index becomes visible only after the folders it describes exist.
    expect(fakeFs.indexReplacements.at(-1)?.operationIndex).toBe(fakeFs.operations.length - 1);
    expect(fakeFs.readFile(MANIFEST_URI)).toBe(JSON.stringify(second));
    // No scratch document of any name survives the publish.
    expect(fakeFs.snapshot().filter(entry => entry.startsWith(MIRROR_ROOT))).toEqual([
      `${MIRROR_ROOT}|<dir>`,
      `${MANIFEST_URI}|${JSON.stringify(second)}`,
      `${SESSIONS_DIR}|<dir>`,
      `${SESSIONS_DIR}/s1|<dir>`,
      `${SESSIONS_DIR}/s2|<dir>`,
    ]);
  });

  it('is idempotent: a second identical snapshot touches nothing', () => {
    const snapshot = snapshotOf([{ id: 's1', files: ['f1'] }, { id: 's2' }]);
    applyArtifactSnapshot(snapshot);
    const tree = fakeFs.snapshot();
    const operations = [...fakeFs.operations];

    applyArtifactSnapshot(snapshot);

    expect(fakeFs.snapshot()).toEqual(tree);
    expect(fakeFs.operations).toEqual(operations);
  });

  it('is a no-op without an app group container', () => {
    fakeFs.setAppGroup(false);

    applyArtifactSnapshot(snapshotOf([{ id: 's1' }]));

    expect(fakeFs.snapshot()).toEqual([]);
  });

  it('never throws when the mirror root cannot be created', () => {
    fakeFs.seedFile(MIRROR_ROOT, 'not a directory');

    expect(() => {
      applyArtifactSnapshot(snapshotOf([{ id: 's1' }]));
    }).not.toThrow();

    expect(fakeFs.readFile(MANIFEST_URI)).toBeUndefined();
  });

  it('replaces an unparseable index with a valid one', () => {
    fakeFs.seedFile(MANIFEST_URI, '{ not json');

    applyArtifactSnapshot(snapshotOf([{ id: 's1' }]));

    expect(readArtifactMirror()).toEqual(snapshotOf([{ id: 's1' }]));
  });
});

describe('readArtifactMirror', () => {
  it('reads back the snapshot that was applied', () => {
    const snapshot = snapshotOf([{ id: 's1', files: ['f1'] }, { id: 's2' }]);

    applyArtifactSnapshot(snapshot);

    expect(readArtifactMirror()).toEqual(snapshot);
  });

  it('reads a missing, unparseable, unknown-version, or unreadable manifest as absent', () => {
    expect(readArtifactMirror()).toBeNull();

    fakeFs.seedFile(MANIFEST_URI, '{ not json');
    expect(readArtifactMirror()).toBeNull();

    fakeFs.seedFile(MANIFEST_URI, '{"version":2,"updatedAt":"","sessions":[]}');
    expect(readArtifactMirror()).toBeNull();

    fakeFs.seedFile(MANIFEST_URI, JSON.stringify(snapshotOf([{ id: 's1' }])));
    fakeFs.setAppGroup(false);
    expect(readArtifactMirror()).toBeNull();
  });
});

describe('mirrorSessionDir', () => {
  it('returns the session folder, or null without an app group container', () => {
    expect(mirrorSessionDir('s1')?.uri).toBe(`${SESSIONS_DIR}/s1`);

    fakeFs.setAppGroup(false);

    expect(mirrorSessionDir('s1')).toBeNull();
  });
});

describe('clearArtifactMirror', () => {
  it('deletes the mirror, leaves the container, and never throws when gone', () => {
    applyArtifactSnapshot(snapshotOf([{ id: 's1', files: ['f1'] }]));

    clearArtifactMirror();

    expect(fakeFs.has(MIRROR_ROOT)).toBe(false);
    expect(fakeFs.has(APP_GROUP_URI)).toBe(true);
    expect(() => {
      clearArtifactMirror();
    }).not.toThrow();

    fakeFs.setAppGroup(false);

    expect(() => {
      clearArtifactMirror();
    }).not.toThrow();
  });
});
