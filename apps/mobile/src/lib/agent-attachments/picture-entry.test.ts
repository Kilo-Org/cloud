import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stagePictureForNewSession } from './picture-entry';
import { __resetSharePayloadStoreForTests, takeSharePayload } from '@/lib/share-payload';

// `putSharePayload` mints the share id; a spy proves the zero-candidate path
// stages nothing at all.
const cryptoMock = vi.hoisted(() => ({ randomUUID: vi.fn(() => 'share-id') }));

vi.mock('expo-crypto', () => cryptoMock);

// `share-payload` imports the native file-system module at load time; the
// payloads staged here are never deleted, so only the shape has to exist (same
// harness as share-payload.test.ts).
const expoFileSystemMock = vi.hoisted(() => ({
  File: vi.fn(function FileMock(uri: string) {
    return { uri, exists: false, delete: vi.fn(), textSync: () => '' };
  }),
  Paths: { cache: { uri: 'file:///cache' } },
}));

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

/** The staged share id, read back from the href the delivery path consumes. */
function shareIdFrom(href: string): string {
  const queryStart = href.indexOf('?');
  const params = new URLSearchParams(queryStart === -1 ? '' : href.slice(queryStart + 1));
  const shareId = params.get('shareId');
  expect(shareId).not.toBeNull();
  return shareId ?? '';
}

beforeEach(() => {
  __resetSharePayloadStoreForTests();
  cryptoMock.randomUUID.mockClear();
});

describe('stagePictureForNewSession', () => {
  it('returns null and stages nothing when no picture was picked', () => {
    expect(stagePictureForNewSession({ candidates: [], organizationId: null })).toBeNull();
    expect(cryptoMock.randomUUID).not.toHaveBeenCalled();
  });

  it('stages one picture and returns the new-session href carrying its share id', () => {
    const candidate = {
      name: 'Screenshot 2026-09-16.png',
      uri: 'file:///cache/screenshot.png',
      mimeType: 'image/png',
      size: 42,
    };

    const href = stagePictureForNewSession({ candidates: [candidate], organizationId: null });

    expect(href).not.toBeNull();
    const resolved = href ?? '';
    expect(resolved.startsWith('/(app)/agent-chat/new')).toBe(true);
    expect(resolved).toContain('shareId=');
    expect(resolved).not.toContain('organizationId');
    expect(takeSharePayload(shareIdFrom(resolved))).toEqual({
      text: '',
      files: [candidate],
      failedFiles: [],
    });
  });

  it('carries the organization id when the caller has one', () => {
    const href = stagePictureForNewSession({
      candidates: [{ name: 'photo.jpg', uri: 'file:///cache/photo.jpg' }],
      organizationId: 'org-1',
    });

    expect(href).toBe('/(app)/agent-chat/new?organizationId=org-1&shareId=share-id');
  });
});
