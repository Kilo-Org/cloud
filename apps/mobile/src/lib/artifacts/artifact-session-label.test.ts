import { describe, expect, it, vi } from 'vitest';

import { buildSessionArtifacts, type MirrorSessionRow } from '@/lib/artifacts/artifact-crawl';
import { safeArtifactSessionName } from '@/lib/artifacts/artifact-mirror-manifest';
import { utf8ByteLength } from '@/lib/utf8-utils';

// The label a session folder shows in the phone's file browser.
//
// A session title is free text from the database, while both
// `NSFileProviderItem.filename` (iOS) and DocumentsProvider's `DISPLAY_NAME`
// (Android) require one bounded, non-empty path component: a title carrying a
// path separator, or an unbounded/empty one, is rejected by the browser and the
// session folder silently disappears. The mirror writes the sanitized label
// once (`safeArtifactSessionName`), so both browsers show the same folder.

vi.mock('expo-file-system', () => ({ Directory: vi.fn(), File: vi.fn(), Paths: {} }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { getAttachmentDownloadUrl: { mutate: vi.fn() } },
    cliSessionsV2: { getSessionMessagesPage: { query: vi.fn() }, list: { query: vi.fn() } },
  },
}));

const UPDATED_AT = '2026-01-01T00:00:00.000Z';

const rowOf = (id: string, title: string | null): MirrorSessionRow => ({
  id,
  title,
  updatedAt: UPDATED_AT,
});

describe('safeArtifactSessionName', () => {
  it('keeps a plain title as the folder label', () => {
    expect(safeArtifactSessionName({ id: 's1', title: 'Runtime settings audit' })).toBe(
      'Runtime settings audit'
    );
  });

  it('keeps only the basename, so a title cannot carry a path', () => {
    expect(safeArtifactSessionName({ id: 's1', title: 'reports/quarter one' })).toBe('quarter one');
    expect(safeArtifactSessionName({ id: 's1', title: 'reports\\quarter one' })).toBe(
      'quarter one'
    );
  });

  it('drops control characters and collapses whitespace', () => {
    expect(safeArtifactSessionName({ id: 's1', title: 'a\u0000b\u001F  c' })).toBe('ab c');
  });

  it('falls back to the session id when no title survives', () => {
    expect(safeArtifactSessionName({ id: 's1', title: null })).toBe('Session s1');
    expect(safeArtifactSessionName({ id: 's1', title: '' })).toBe('Session s1');
    expect(safeArtifactSessionName({ id: 's1', title: '   ' })).toBe('Session s1');
    expect(safeArtifactSessionName({ id: 's1', title: '..' })).toBe('Session s1');
    expect(safeArtifactSessionName({ id: 's1', title: '\u0000\u0001' })).toBe('Session s1');
  });

  it('sanitizes the id the fallback is built from', () => {
    expect(safeArtifactSessionName({ id: 'a/b\u0000c', title: null })).toBe('Session bc');
    expect(safeArtifactSessionName({ id: '/', title: null })).toBe('Session');
  });

  it('bounds a long title to 200 bytes', () => {
    const label = safeArtifactSessionName({ id: 's1', title: 'ä'.repeat(300) });

    expect(utf8ByteLength(label)).toBe(200);
  });
});

describe('buildSessionArtifacts session labels', () => {
  it('writes the sanitized label into the manifest session entry', () => {
    const longTitle = 'ä'.repeat(300);

    const sessions = buildSessionArtifacts(
      [
        rowOf('s1', 'reports/quarter one'),
        rowOf('s2', ''),
        rowOf('s3', longTitle),
        rowOf('s4', null),
      ],
      new Map()
    );

    expect(sessions.map(session => session.title)).toEqual([
      'quarter one',
      'Session s2',
      expect.any(String),
      'Session s4',
    ]);
    expect(utf8ByteLength(sessions[2]?.title ?? '')).toBe(200);
  });
});
