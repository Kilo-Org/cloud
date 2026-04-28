import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchPushCore } from '../dos/NotificationChannelDO';
import type { DispatchPushDeps, DispatchPushInput } from '../dos/NotificationChannelDO';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a chainable drizzle-like mock. The mock's `.where()` resolves to
 * `tokenRows` on the first call (token lookup) and to `[{ total: badgeTotal }]`
 * on the second call (badge sum).
 */
function makeDbMock(tokenRows: { token: string }[] = [], badgeTotal = 3) {
  let selectCount = 0;
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return Promise.resolve(tokenRows);
      return Promise.resolve([{ total: String(badgeTotal) }]);
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockReturnThis(),
  };
  return db;
}

/** Build a minimal in-memory DurableObjectStorage-alike for tests. */
function makeStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    list: vi.fn(async () => new Map()),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
    transaction: vi.fn(),
    transactionSync: vi.fn(),
    sql: vi.fn(),
    getCurrentBookmark: vi.fn(),
    getBookmarkForTime: vi.fn(),
    onNextSessionRestoreBookmark: vi.fn(),
  } as unknown as DurableObjectStorage;
}

/** Build the full deps object with sensible defaults. */
function makeDeps(overrides: Partial<DispatchPushDeps> = {}): DispatchPushDeps {
  return {
    storage: makeStorage(),
    isUserInContext: vi.fn().mockResolvedValue(false),
    getAccessToken: vi.fn().mockResolvedValue('test-expo-token'),
    sendPush: vi.fn().mockResolvedValue({ ticketTokenPairs: [], staleTokens: [] }),
    db: makeDbMock([{ token: 'tok-1' }]) as unknown as ReturnType<
      typeof import('@kilocode/db/client').getWorkerDb
    >,
    sendToQueue: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseInput: DispatchPushInput = {
  userId: 'u1',
  presenceContext: '/presence/kiloclaw/chat/c1',
  idempotencyKey: 'k1',
  badge: { badgeBucket: 'c1', delta: 1 },
  push: {
    title: 'T',
    body: 'B',
    data: { type: 'chat.message', sandboxId: 's', conversationId: 'c1', messageId: 'm1' },
    sound: 'default',
    priority: 'high',
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('dispatchPushCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns suppressed_presence when isUserInContext is true', async () => {
    const deps = makeDeps({ isUserInContext: vi.fn().mockResolvedValue(true) });

    const out = await dispatchPushCore(baseInput, deps);

    expect(out.kind).toBe('suppressed_presence');
    expect(deps.sendPush).not.toHaveBeenCalled();
    expect(deps.db.select).not.toHaveBeenCalled();
  });

  it('returns no_tokens when user has no push tokens', async () => {
    const deps = makeDeps({
      db: makeDbMock([]) as unknown as ReturnType<typeof import('@kilocode/db/client').getWorkerDb>,
    });

    const out = await dispatchPushCore(baseInput, deps);

    expect(out.kind).toBe('no_tokens');
    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it('returns duplicate when idempotencyKey already stored', async () => {
    // Pre-seed the storage with the idempotency key
    const storage = makeStorage();
    (storage.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Date.now());
    const deps = makeDeps({ storage });

    const out = await dispatchPushCore(baseInput, deps);

    expect(out.kind).toBe('duplicate');
    expect(deps.isUserInContext).not.toHaveBeenCalled();
    expect(deps.sendPush).not.toHaveBeenCalled();
  });

  it('delivers, increments badge, writes idempotency key on first delivery', async () => {
    const db = makeDbMock([{ token: 'tok-a' }, { token: 'tok-b' }], 5);
    const sendPush = vi.fn().mockResolvedValue({
      ticketTokenPairs: [{ ticketId: 'tid-1', token: 'tok-a' }],
      staleTokens: [],
    });
    const storage = makeStorage();
    const deps = makeDeps({
      db: db as unknown as ReturnType<typeof import('@kilocode/db/client').getWorkerDb>,
      sendPush,
      storage,
    });

    const out = await dispatchPushCore(baseInput, deps);

    expect(out.kind).toBe('delivered');
    if (out.kind === 'delivered') {
      expect(out.tokenCount).toBe(2);
    }
    expect(sendPush).toHaveBeenCalledOnce();
    // Badge upsert called
    expect(db.insert).toHaveBeenCalledOnce();
    // Receipt queue notified
    expect(deps.sendToQueue).toHaveBeenCalledOnce();
    // Idempotency key written
    expect(storage.put).toHaveBeenCalledWith('idem:k1', expect.any(Number));
  });

  it('skips badge mutation and omits badge from push message when badge is null', async () => {
    const db = makeDbMock([{ token: 'tok-x' }]);
    const sendPush = vi.fn().mockResolvedValue({ ticketTokenPairs: [], staleTokens: [] });
    const deps = makeDeps({
      db: db as unknown as ReturnType<typeof import('@kilocode/db/client').getWorkerDb>,
      sendPush,
    });

    const out = await dispatchPushCore({ ...baseInput, badge: null }, deps);

    expect(out.kind).toBe('delivered');
    // No badge upsert
    expect(db.insert).not.toHaveBeenCalled();
    // Only one select call (token lookup — no badge sum)
    expect(db.where).toHaveBeenCalledOnce();
    // Expo message should not contain a badge property
    const [messages] = sendPush.mock.calls[0] ?? [];
    expect((messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty('badge');
  });
});
