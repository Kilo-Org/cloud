import { describe, it, expect, vi, beforeEach } from 'vitest';

// Undo the global mock from setup.ts so we test the real implementation
vi.unmock('../services/user-lookup');

import { resolveUserDisplayInfo, validateUserIds } from '../services/user-lookup';

// Mock @kilocode/db so we don't need Hyperdrive in tests
const mockSelect = vi.fn();

vi.mock('@kilocode/db', () => ({
  getWorkerDb: (_connectionString: string) => ({
    select: mockSelect,
  }),
}));

// Minimal chainable query builder that captures calls
function makeChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown[]) => void) => resolve(result),
  };
  return chain;
}

const CONN = 'postgres://fake/db';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── resolveUserDisplayInfo ───────────────────────────────────────────────────

describe('resolveUserDisplayInfo', () => {
  it('returns empty Map for empty input', async () => {
    const result = await resolveUserDisplayInfo(CONN, []);
    expect(result.size).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns { displayName: null, avatarUrl: null } for bot: prefixed IDs without querying', async () => {
    const result = await resolveUserDisplayInfo(CONN, ['bot:kiloclaw:sandbox-1', 'bot:other']);
    expect(result.size).toBe(2);
    expect(result.get('bot:kiloclaw:sandbox-1')).toEqual({ displayName: null, avatarUrl: null });
    expect(result.get('bot:other')).toEqual({ displayName: null, avatarUrl: null });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('uses auth provider display_name and avatar_url when present', async () => {
    const rows = [
      {
        id: 'user-1',
        google_user_name: 'Google User',
        google_user_image_url: 'https://example.com/google.jpg',
        display_name: 'Auth Display Name',
        avatar_url: 'https://example.com/auth.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-1']);
    expect(result.get('user-1')).toEqual({
      displayName: 'Auth Display Name',
      avatarUrl: 'https://example.com/auth.jpg',
    });
  });

  it('falls back to google_user_name when display_name is null', async () => {
    const rows = [
      {
        id: 'user-2',
        google_user_name: 'Google Fallback',
        google_user_image_url: 'https://example.com/goog.jpg',
        display_name: null,
        avatar_url: 'https://example.com/auth.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-2']);
    expect(result.get('user-2')).toEqual({
      displayName: 'Google Fallback',
      avatarUrl: 'https://example.com/auth.jpg',
    });
  });

  it('returns null displayName when user has no rows at all', async () => {
    mockSelect.mockReturnValue(makeChain([]));

    const result = await resolveUserDisplayInfo(CONN, ['user-missing']);
    expect(result.get('user-missing')).toEqual({ displayName: null, avatarUrl: null });
  });

  it('picks the most recent auth row with non-null display_name', async () => {
    // user-3 has two auth providers — older one has display_name, newer one doesn't
    // should pick the older one for display_name since it's the most recent WITH display_name
    const rows = [
      {
        id: 'user-3',
        google_user_name: 'Google Name',
        google_user_image_url: 'https://example.com/g.jpg',
        display_name: 'Older Auth Name',
        avatar_url: 'https://example.com/older.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-3',
        google_user_name: 'Google Name',
        google_user_image_url: 'https://example.com/g.jpg',
        display_name: null,
        avatar_url: 'https://example.com/newer.jpg',
        created_at: '2024-06-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-3']);
    expect(result.get('user-3')).toEqual({
      displayName: 'Older Auth Name',
      avatarUrl: 'https://example.com/older.jpg',
    });
  });

  it('uses the most recent row for avatar when no row has a display_name', async () => {
    // Both rows have null display_name — use most recent row's avatar for avatarUrl
    const rows = [
      {
        id: 'user-4',
        google_user_name: 'Google Name',
        google_user_image_url: 'https://example.com/g.jpg',
        display_name: null,
        avatar_url: 'https://example.com/older-avatar.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-4',
        google_user_name: 'Google Name',
        google_user_image_url: 'https://example.com/g.jpg',
        display_name: null,
        avatar_url: 'https://example.com/newer-avatar.jpg',
        created_at: '2024-06-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-4']);
    expect(result.get('user-4')).toEqual({
      displayName: 'Google Name',
      avatarUrl: 'https://example.com/newer-avatar.jpg',
    });
  });

  it('handles a mix of bot and real user IDs', async () => {
    const rows = [
      {
        id: 'user-5',
        google_user_name: 'Real User',
        google_user_image_url: 'https://example.com/real.jpg',
        display_name: 'Display 5',
        avatar_url: 'https://example.com/avatar5.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-5', 'bot:kiloclaw:box-1']);
    expect(result.size).toBe(2);
    expect(result.get('user-5')).toEqual({
      displayName: 'Display 5',
      avatarUrl: 'https://example.com/avatar5.jpg',
    });
    expect(result.get('bot:kiloclaw:box-1')).toEqual({ displayName: null, avatarUrl: null });
  });

  it('handles multiple real users in a single batch query', async () => {
    const rows = [
      {
        id: 'user-a',
        google_user_name: 'User A',
        google_user_image_url: 'https://example.com/a.jpg',
        display_name: 'A Display',
        avatar_url: 'https://example.com/avatar-a.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-b',
        google_user_name: 'User B',
        google_user_image_url: 'https://example.com/b.jpg',
        display_name: null,
        avatar_url: 'https://example.com/avatar-b.jpg',
        created_at: '2024-01-01T00:00:00Z',
      },
    ];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await resolveUserDisplayInfo(CONN, ['user-a', 'user-b']);
    // Only one DB call (batch query)
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result.get('user-a')).toEqual({
      displayName: 'A Display',
      avatarUrl: 'https://example.com/avatar-a.jpg',
    });
    expect(result.get('user-b')).toEqual({
      displayName: 'User B',
      avatarUrl: 'https://example.com/avatar-b.jpg',
    });
  });
});

// ─── validateUserIds ──────────────────────────────────────────────────────────

describe('validateUserIds', () => {
  it('returns empty lists for empty input', async () => {
    const result = await validateUserIds(CONN, []);
    expect(result).toEqual({ valid: [], invalid: [] });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns all ids as valid when all exist', async () => {
    const rows = [{ id: 'user-1' }, { id: 'user-2' }];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await validateUserIds(CONN, ['user-1', 'user-2']);
    expect(result.valid.sort()).toEqual(['user-1', 'user-2']);
    expect(result.invalid).toEqual([]);
  });

  it('returns missing ids as invalid', async () => {
    const rows = [{ id: 'user-1' }];
    mockSelect.mockReturnValue(makeChain(rows));

    const result = await validateUserIds(CONN, ['user-1', 'user-ghost']);
    expect(result.valid).toEqual(['user-1']);
    expect(result.invalid).toEqual(['user-ghost']);
  });

  it('returns all ids as invalid when none exist', async () => {
    mockSelect.mockReturnValue(makeChain([]));

    const result = await validateUserIds(CONN, ['ghost-1', 'ghost-2']);
    expect(result.valid).toEqual([]);
    expect(result.invalid.sort()).toEqual(['ghost-1', 'ghost-2']);
  });

  it('uses a single batch query', async () => {
    const rows = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    mockSelect.mockReturnValue(makeChain(rows));

    await validateUserIds(CONN, ['u1', 'u2', 'u3']);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });
});
