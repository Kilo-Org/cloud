import { describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_MIRROR_MANIFEST_VERSION,
  type ArtifactMirrorManifest,
  type ArtifactMirrorSession,
  parseArtifactMirrorManifest,
  safeArtifactDisplayName,
  selectSessionsWithinBudget,
  serializeArtifactMirrorManifest,
} from '@/lib/artifacts/artifact-mirror-manifest';
import { utf8ByteLength } from '@/lib/utf8-utils';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  Paths: {},
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const SESSION_UPDATED_AT = '2026-01-01T00:00:00.000Z';

function sessionOf(
  id: string,
  {
    updatedAt = SESSION_UPDATED_AT,
    files = [],
  }: { updatedAt?: string; files?: { id: string; size: number }[] } = {}
): ArtifactMirrorSession {
  return {
    id,
    title: `Session ${id}`,
    updatedAt,
    files: files.map(file => ({
      id: file.id,
      name: `${file.id}.txt`,
      mime: 'text/plain',
      size: file.size,
    })),
  };
}

function manifestOf(sessions: ArtifactMirrorSession[]): ArtifactMirrorManifest {
  return { version: ARTIFACT_MIRROR_MANIFEST_VERSION, updatedAt: SESSION_UPDATED_AT, sessions };
}

describe('parseArtifactMirrorManifest', () => {
  it('reads an absent manifest as absent', () => {
    expect(parseArtifactMirrorManifest(null)).toBeNull();
  });

  it('reads unparseable JSON as absent', () => {
    expect(parseArtifactMirrorManifest('{ not json')).toBeNull();
    expect(parseArtifactMirrorManifest('null')).toBeNull();
  });

  it('reads a document with the wrong shape as absent', () => {
    expect(parseArtifactMirrorManifest('[]')).toBeNull();
    expect(
      parseArtifactMirrorManifest(JSON.stringify({ version: 2, updatedAt: '', sessions: [] }))
    ).toBeNull();
    expect(parseArtifactMirrorManifest(JSON.stringify({ version: 1, sessions: [] }))).toBeNull();
    expect(
      parseArtifactMirrorManifest(
        JSON.stringify({
          version: 1,
          updatedAt: SESSION_UPDATED_AT,
          sessions: [
            {
              id: 's1',
              title: 't',
              updatedAt: SESSION_UPDATED_AT,
              files: [{ id: 'f1', name: 'a', mime: 'text/plain', size: '3' }],
            },
          ],
        })
      )
    ).toBeNull();
  });

  it('parses a valid document', () => {
    const manifest = manifestOf([sessionOf('s1', { files: [{ id: 'f1', size: 3 }] })]);

    expect(parseArtifactMirrorManifest(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe('serializeArtifactMirrorManifest', () => {
  it('emits a fixed key order so identical content is byte-identical', () => {
    const manifest = manifestOf([sessionOf('s1', { files: [{ id: 'f1', size: 3 }] })]);
    const file = manifest.sessions[0]?.files[0];
    const session = manifest.sessions[0];
    if (!file || !session) {
      throw new Error('fixture missing');
    }

    // Same values, every object built in a different key order.
    const reordered: ArtifactMirrorManifest = {
      sessions: [
        {
          files: [{ size: file.size, mime: file.mime, name: file.name, id: file.id }],
          updatedAt: session.updatedAt,
          title: session.title,
          id: session.id,
        },
      ],
      updatedAt: manifest.updatedAt,
      version: manifest.version,
    };

    expect(serializeArtifactMirrorManifest(reordered)).toBe(
      serializeArtifactMirrorManifest(manifest)
    );
    expect(serializeArtifactMirrorManifest(manifest)).toBe(
      `{"version":1,"updatedAt":"${SESSION_UPDATED_AT}","sessions":[{"id":"s1","title":"Session s1","updatedAt":"${SESSION_UPDATED_AT}","files":[{"id":"f1","name":"f1.txt","mime":"text/plain","size":3}]}]}`
    );
  });

  it('round-trips through the schema', () => {
    const manifest = manifestOf([sessionOf('s1', { files: [{ id: 'f1', size: 3 }] })]);

    expect(parseArtifactMirrorManifest(serializeArtifactMirrorManifest(manifest))).toEqual(
      manifest
    );
  });
});

describe('safeArtifactDisplayName', () => {
  const fallbackId = 'part-1';
  const png = 'image/png';

  it('keeps only the basename, so a name cannot carry a path', () => {
    expect(
      safeArtifactDisplayName({ id: fallbackId, name: 'reports/q1.pdf', mime: 'application/pdf' })
    ).toBe('q1.pdf');
    expect(
      safeArtifactDisplayName({ id: fallbackId, name: 'reports\\q1.pdf', mime: 'application/pdf' })
    ).toBe('q1.pdf');
    expect(
      safeArtifactDisplayName({ id: fallbackId, name: '../../etc/passwd', mime: 'text/plain' })
    ).toBe('passwd');
    expect(
      safeArtifactDisplayName({ id: fallbackId, name: 'a/b\\c.txt', mime: 'text/plain' })
    ).toBe('c.txt');
  });

  it('drops C0, DEL, and C1 control characters', () => {
    expect(
      safeArtifactDisplayName({
        id: fallbackId,
        name: 'a\u0000b\u001Fc\u007Fd\u0085e.txt',
        mime: 'text/plain',
      })
    ).toBe('abcde.txt');
  });

  it('collapses whitespace runs and trims the ends', () => {
    expect(
      safeArtifactDisplayName({ id: fallbackId, name: '  a   b.txt  ', mime: 'text/plain' })
    ).toBe('a b.txt');
  });

  it('bounds a long name to 200 bytes and keeps the extension', () => {
    const name = `${'ä'.repeat(300)}.pdf`;
    const displayName = safeArtifactDisplayName({ id: fallbackId, name, mime: 'application/pdf' });

    expect(utf8ByteLength(displayName)).toBe(200);
    expect(displayName.endsWith('.pdf')).toBe(true);
  });

  it('bounds a long name without an extension', () => {
    const displayName = safeArtifactDisplayName({
      id: fallbackId,
      name: 'ä'.repeat(300),
      mime: 'text/plain',
    });

    expect(utf8ByteLength(displayName)).toBe(200);
  });

  it('falls back to the id and MIME extension when no name survives', () => {
    expect(safeArtifactDisplayName({ id: fallbackId, name: '', mime: png })).toBe('part-1.png');
    expect(safeArtifactDisplayName({ id: fallbackId, name: '/', mime: png })).toBe('part-1.png');
    expect(safeArtifactDisplayName({ id: fallbackId, name: '\u0000\u0001', mime: png })).toBe(
      'part-1.png'
    );
    expect(safeArtifactDisplayName({ id: fallbackId, name: '.', mime: png })).toBe('part-1.png');
    expect(safeArtifactDisplayName({ id: fallbackId, name: '..', mime: png })).toBe('part-1.png');
  });

  it('maps the fallback extension from the MIME type', () => {
    expect(safeArtifactDisplayName({ id: fallbackId, name: '', mime: 'application/pdf' })).toBe(
      'part-1.pdf'
    );
    expect(safeArtifactDisplayName({ id: fallbackId, name: '', mime: 'image/jpeg' })).toBe(
      'part-1.jpg'
    );
    expect(safeArtifactDisplayName({ id: fallbackId, name: '', mime: 'not-a-mime' })).toBe(
      'part-1.bin'
    );
  });

  it('sanitizes the id used by the fallback', () => {
    expect(safeArtifactDisplayName({ id: 'a/b\u0000c', name: '', mime: 'text/plain' })).toBe(
      'bc.plain'
    );
  });
});

describe('selectSessionsWithinBudget', () => {
  it('keeps every session when the files fit', () => {
    const sessions = [
      sessionOf('newer', {
        updatedAt: '2026-02-01T00:00:00.000Z',
        files: [{ id: 'f1', size: 100 }],
      }),
      sessionOf('older', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [{ id: 'f2', size: 100 }],
      }),
    ];

    expect(selectSessionsWithinBudget(sessions, 200)).toEqual(sessions);
  });

  it('drops the oldest session files first and keeps its folder entry', () => {
    const sessions = [
      sessionOf('newer', {
        updatedAt: '2026-02-01T00:00:00.000Z',
        files: [{ id: 'f1', size: 100 }],
      }),
      sessionOf('older', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [{ id: 'f2', size: 100 }],
      }),
    ];

    const selected = selectSessionsWithinBudget(sessions, 150);

    expect(selected.map(session => session.id)).toEqual(['newer', 'older']);
    expect(selected[0]?.files).toHaveLength(1);
    expect(selected[1]?.files).toEqual([]);
  });

  it('empties every session but keeps the entries when the budget is zero', () => {
    const sessions = [
      sessionOf('b', { updatedAt: '2026-02-01T00:00:00.000Z', files: [{ id: 'f1', size: 1 }] }),
      sessionOf('a', { updatedAt: '2026-01-01T00:00:00.000Z', files: [{ id: 'f2', size: 1 }] }),
    ];

    const selected = selectSessionsWithinBudget(sessions, 0);

    expect(selected.map(session => session.id)).toEqual(['b', 'a']);
    expect(selected.every(session => session.files.length === 0)).toBe(true);
  });

  it('drops as many oldest sessions as the budget needs', () => {
    const sessions = [
      sessionOf('newest', {
        updatedAt: '2026-03-01T00:00:00.000Z',
        files: [{ id: 'f1', size: 100 }],
      }),
      sessionOf('middle', {
        updatedAt: '2026-02-01T00:00:00.000Z',
        files: [{ id: 'f2', size: 100 }],
      }),
      sessionOf('oldest', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [{ id: 'f3', size: 100 }],
      }),
    ];

    const selected = selectSessionsWithinBudget(sessions, 150);

    expect(selected[0]?.files).toHaveLength(1);
    expect(selected[1]?.files).toEqual([]);
    expect(selected[2]?.files).toEqual([]);
  });

  it('keeps the input order and does not mutate the input', () => {
    const sessions = [
      sessionOf('newer', {
        updatedAt: '2026-02-01T00:00:00.000Z',
        files: [{ id: 'f1', size: 100 }],
      }),
      sessionOf('older', {
        updatedAt: '2026-01-01T00:00:00.000Z',
        files: [{ id: 'f2', size: 100 }],
      }),
    ];

    const selected = selectSessionsWithinBudget(sessions, 0);

    expect(selected.map(session => session.id)).toEqual(['newer', 'older']);
    expect(sessions[0]?.files).toHaveLength(1);
    expect(sessions[1]?.files).toHaveLength(1);
  });

  it('breaks an updatedAt tie by the snapshot order', () => {
    const sameMoment = '2026-01-01T00:00:00.000Z';
    const sessions = [
      sessionOf('first', { updatedAt: sameMoment, files: [{ id: 'f1', size: 100 }] }),
      sessionOf('second', { updatedAt: sameMoment, files: [{ id: 'f2', size: 100 }] }),
    ];

    const selected = selectSessionsWithinBudget(sessions, 100);

    expect(selected[0]?.files).toEqual([]);
    expect(selected[1]?.files).toHaveLength(1);
  });
});
