import type * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventServiceClient } from '@kilocode/event-service';
import {
  type BotStatusEvent,
  type BotStatusRecord,
  type KiloChatClient,
} from '@kilocode/kilo-chat';

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  // Persistent state slots that survive across simulated re-renders.
  stateSlots: [] as unknown[],
  slotCursor: 0,
  // Effects run synchronously; cleanups collected here.
  cleanups: [] as Array<() => void>,
  // tanstack query mocks
  queryData: new Map<string, unknown>(),
  invalidateCalls: [] as Array<{ queryKey: unknown }>,
  queryCalls: [] as Array<{ queryKey: unknown; queryFn: () => Promise<unknown>; enabled: boolean }>,
}));

/** Call before each simulated render to reset the slot cursor. */
function beginRender() {
  testState.slotCursor = 0;
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slotIndex = testState.slotCursor++;
      // On first render for this slot, initialize with `initial`.
      if (testState.stateSlots.length <= slotIndex) {
        testState.stateSlots.push(initial);
      }
      const currentValue = testState.stateSlots[slotIndex];
      const setter = (v: unknown) => {
        testState.stateSlots[slotIndex] = v;
      };
      return [currentValue, setter];
    },
    useEffect: (effect: ReactModule.EffectCallback) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        testState.cleanups.push(cleanup);
      }
    },
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: (key: unknown) => testState.queryData.get(JSON.stringify(key)),
    setQueryData: (key: unknown, updater: (prev: unknown) => unknown) => {
      const k = JSON.stringify(key);
      testState.queryData.set(k, updater(testState.queryData.get(k)));
    },
    invalidateQueries: (opts: { queryKey: unknown }) => {
      testState.invalidateCalls.push(opts);
    },
  }),
  useQuery: (opts: { queryKey: unknown; queryFn: () => Promise<unknown>; enabled: boolean }) => {
    testState.queryCalls.push(opts);
    const key = JSON.stringify(opts.queryKey);
    return { data: testState.queryData.get(key) };
  },
}));

// ─── Import under test (after mocks) ────────────────────────────────────────

import { reduceBotStatusOnEvent, useBotStatus } from './use-bot-status';
import { botStatusKey } from './query-keys';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function event(overrides: Partial<BotStatusEvent> = {}): BotStatusEvent {
  return {
    sandboxId: 'sb-1',
    online: true,
    at: 1000,
    capabilities: undefined,
    ...overrides,
  } as BotStatusEvent;
}

function record(overrides: Partial<BotStatusRecord> = {}): BotStatusRecord {
  return { online: true, at: 1000, updatedAt: 1000, capabilities: undefined, ...overrides };
}

function makeClients({ connected = false } = {}) {
  const capturedOnConnected: Array<() => void> = [];
  const capturedBotStatus: Array<(ctx: string, ev: BotStatusEvent) => void> = [];

  const eventClient = {
    onConnected: vi.fn((handler: () => void) => {
      capturedOnConnected.push(handler);
      if (connected) handler();
      return () => {
        const i = capturedOnConnected.indexOf(handler);
        if (i >= 0) capturedOnConnected.splice(i, 1);
      };
    }),
  };

  const mockRequestBotStatus =
    vi.fn<(id: string) => Promise<{ ok: true; cached: BotStatusRecord | null }>>();
  mockRequestBotStatus.mockResolvedValue({ ok: true, cached: null });

  const kiloChatClient = {
    onBotStatus: vi.fn((handler: (ctx: string, ev: BotStatusEvent) => void) => {
      capturedBotStatus.push(handler);
      return () => {
        const i = capturedBotStatus.indexOf(handler);
        if (i >= 0) capturedBotStatus.splice(i, 1);
      };
    }),
    requestBotStatus: mockRequestBotStatus,
  };

  return {
    eventClient: eventClient as unknown as EventServiceClient,
    kiloChatClient: kiloChatClient as unknown as KiloChatClient,
    fireConnected: () => capturedOnConnected.forEach(h => h()),
    fireBotStatus: (ev: BotStatusEvent) => capturedBotStatus.forEach(h => h('ctx', ev)),
    mockRequestBotStatus,
  };
}

// ─── reduceBotStatusOnEvent (pure function, unchanged) ───────────────────────

describe('reduceBotStatusOnEvent', () => {
  it('writes the event into an empty cache, preserving capabilities', () => {
    const next = reduceBotStatusOnEvent(
      undefined,
      event({ at: 1000, capabilities: ['attachments'] })
    );
    expect(next).toEqual({
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    });
  });

  it('keeps the previous record when the event is older', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 2000,
      updatedAt: 2000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(prev, event({ at: 1000, capabilities: undefined }));
    expect(next).toBe(prev);
  });

  it('updates online + at and preserves previous capabilities when the event omits them', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(
      prev,
      event({ at: 2000, online: false, capabilities: undefined })
    );
    expect(next).toEqual({
      online: false,
      at: 2000,
      updatedAt: 2000,
      capabilities: ['attachments'],
    });
  });

  it('overwrites capabilities when the event includes a new list', () => {
    const prev: BotStatusRecord = {
      online: true,
      at: 1000,
      updatedAt: 1000,
      capabilities: ['attachments'],
    };
    const next = reduceBotStatusOnEvent(prev, event({ at: 2000, capabilities: [] }));
    expect(next).toEqual({
      online: true,
      at: 2000,
      updatedAt: 2000,
      capabilities: [],
    });
  });
});

// ─── useBotStatus hook ───────────────────────────────────────────────────────

describe('useBotStatus', () => {
  beforeEach(() => {
    testState.stateSlots = [];
    testState.slotCursor = 0;
    testState.cleanups = [];
    testState.queryData.clear();
    testState.invalidateCalls = [];
    testState.queryCalls = [];
  });

  afterEach(() => {
    for (const cleanup of testState.cleanups) {
      cleanup();
    }
  });

  it('query is disabled until onConnected fires (wsReady gate)', () => {
    const { eventClient, kiloChatClient } = makeClients({ connected: false });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    // wsReady starts as false — query should be disabled
    const queryCall = testState.queryCalls[0];
    expect(queryCall).toBeDefined();
    expect(queryCall?.enabled).toBe(false);
  });

  it('query becomes enabled once WS connects', () => {
    const { eventClient, kiloChatClient } = makeClients({ connected: true });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    // onConnected fires synchronously when connected=true, which calls setWsReady(true).
    // In real React this triggers a re-render; verify the slot was updated.
    expect(testState.stateSlots[0]).toBe(true);

    // Simulate the re-render: reset cursor + effects/queries for the second pass.
    testState.queryCalls = [];
    // (Don't reset cleanups — effects shouldn't re-run on a state-only re-render.)

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const queryCall = testState.queryCalls[0];
    expect(queryCall?.enabled).toBe(true);
  });

  it('queryFn returns cached record when server provides one', async () => {
    const cached = record({ at: 2000 });
    const { eventClient, kiloChatClient, mockRequestBotStatus } = makeClients({ connected: true });
    mockRequestBotStatus.mockResolvedValue({ ok: true, cached });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const queryCall = testState.queryCalls[0];
    expect(queryCall).toBeDefined();
    const result = await queryCall?.queryFn();
    expect(result).toEqual(cached);
  });

  it('queryFn returns null when cached is null', async () => {
    const { eventClient, kiloChatClient, mockRequestBotStatus } = makeClients({ connected: true });
    mockRequestBotStatus.mockResolvedValue({ ok: true, cached: null });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const queryCall = testState.queryCalls[0];
    const result = await queryCall?.queryFn();
    expect(result).toBeNull();
  });

  it('queryFn keeps fresher WS record when cached is older', async () => {
    const fresherRecord = record({ at: 5000 });
    const staleRecord = record({ at: 1000 });
    const key = JSON.stringify(botStatusKey('sb-1'));

    const { eventClient, kiloChatClient, mockRequestBotStatus } = makeClients({ connected: true });
    mockRequestBotStatus.mockResolvedValue({ ok: true, cached: staleRecord });

    // Pre-seed cache with a fresher record (simulating a WS event arriving in-flight)
    testState.queryData.set(key, fresherRecord);

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const queryCall = testState.queryCalls[0];
    const result = await queryCall?.queryFn();
    // Should keep fresher WS record, not clobber with stale cached
    expect(result).toBe(fresherRecord);
  });

  it('queryFn preserves a WS record that lands after requestBotStatus resolves', async () => {
    // Scenario: server returns cached={at:2000}, but a WS event with at=3000 arrives
    // and writes to the cache between requestBotStatus resolving and queryFn returning.
    // The functional setQueryData should see the WS record as prev and keep it.
    const serverRecord = record({ at: 2000, online: false });
    const wsRecord = record({ at: 3000, online: true });
    const key = JSON.stringify(botStatusKey('sb-1'));

    const { eventClient, kiloChatClient, mockRequestBotStatus } = makeClients({ connected: true });

    // requestBotStatus returns the server record (at=2000).
    mockRequestBotStatus.mockResolvedValue({ ok: true, cached: serverRecord });

    // Pre-seed the cache with the WS record (at=3000) *before* calling queryFn,
    // simulating a WS event that landed while the HTTP request was in flight.
    testState.queryData.set(key, wsRecord);

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const queryCall = testState.queryCalls[0];
    const result = await queryCall?.queryFn();

    // The functional updater sees wsRecord (at=3000) as prev and keeps it,
    // because wsRecord.at > serverRecord.at.
    expect(testState.queryData.get(key)).toBe(wsRecord);
    expect(result).toBe(wsRecord);
  });

  it('WS bot.status event is reduced into the query cache', () => {
    const { eventClient, kiloChatClient, fireBotStatus } = makeClients({ connected: true });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    const newEvent = event({ at: 3000, online: false });
    fireBotStatus(newEvent);

    const key = JSON.stringify(botStatusKey('sb-1'));
    const cached = testState.queryData.get(key) as BotStatusRecord;
    expect(cached).toEqual({
      online: false,
      at: 3000,
      updatedAt: 3000,
      capabilities: undefined,
    });
  });

  it('WS event does not clobber a fresher existing record', () => {
    const existing = record({ at: 9000, online: true });
    const key = JSON.stringify(botStatusKey('sb-1'));
    testState.queryData.set(key, existing);

    const { eventClient, kiloChatClient, fireBotStatus } = makeClients({ connected: true });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    fireBotStatus(event({ at: 1000, online: false }));

    expect(testState.queryData.get(key)).toBe(existing);
  });

  it('reconnect triggers invalidateQueries for the sandbox', () => {
    const { eventClient, kiloChatClient, fireConnected } = makeClients({ connected: false });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, 'sb-1');

    expect(testState.invalidateCalls).toHaveLength(0);

    fireConnected();

    expect(testState.invalidateCalls).toHaveLength(1);
    expect(testState.invalidateCalls[0]?.queryKey).toEqual(botStatusKey('sb-1'));
  });

  it('query is disabled when sandboxId is null', () => {
    const { eventClient, kiloChatClient } = makeClients({ connected: true });

    beginRender();
    useBotStatus(kiloChatClient, eventClient, null);

    const queryCall = testState.queryCalls[0];
    // enabled = sandboxId !== null && wsReady → false
    expect(queryCall?.enabled).toBe(false);
  });
});
