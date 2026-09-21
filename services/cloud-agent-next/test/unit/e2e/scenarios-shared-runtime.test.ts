import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMessageResult: vi.fn(),
  getSessionSnapshot: vi.fn(),
  openConnectedStream: vi.fn(),
  sendMessage: vi.fn(),
  fetchFakeRequests: vi.fn(),
  fakeDirective: vi.fn((conversation: string) => `__fake__:${conversation}`),
  isMessageCompleted: vi.fn(
    (event: { streamEventType: string; data?: { messageId?: string } } | null, messageId: string) =>
      event !== null &&
      event.streamEventType === 'cloud.message.completed' &&
      event.data?.messageId === messageId
  ),
}));

vi.mock('../../e2e/client.js', () => ({
  getMessageResult: mocks.getMessageResult,
  getSessionSnapshot: mocks.getSessionSnapshot,
  openConnectedStream: mocks.openConnectedStream,
  sendMessage: mocks.sendMessage,
  fetchFakeRequests: mocks.fetchFakeRequests,
  fakeDirective: mocks.fakeDirective,
  isMessageCompleted: mocks.isMessageCompleted,
}));

import type { DriverConfig, StreamEvent } from '../../e2e/client.js';
import type { SessionSandboxObservation } from '../../e2e/scenario-capabilities.js';
import {
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  requireContainer,
  sendTurn,
  sessionSandboxObservation,
  startPacedHoldTurn,
  trackCreations,
  trackStartedSession,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from '../../e2e/scenarios-shared-runtime.js';

const SESSION = { cloudAgentSessionId: 'workspace_1', kiloSessionId: 'ses_1' };

const CONFIG: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  user: { id: 'usr_1' },
  skipBalanceCheck: false,
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'https://fake.example.test',
};

function terminalEvent(): StreamEvent {
  return {
    eventId: 1,
    executionId: null,
    sessionId: 'workspace_1',
    streamEventType: 'cloud.message.completed',
    timestamp: new Date(0).toISOString(),
    data: {},
  };
}

function completedEvent(messageId: string): StreamEvent {
  return { ...terminalEvent(), data: { messageId } };
}

function fakeStream(terminal: StreamEvent | null = null) {
  const waitForTerminal = vi.fn(
    async (_timeoutMs: number, _messageId?: string): Promise<StreamEvent | null> => terminal
  );
  return {
    events: [] as StreamEvent[],
    waitForTerminal,
    waitFor: vi.fn(async () => null),
    receivedCount: 0,
    isOpen: true,
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createScenarioDeadline', () => {
  it('resolves a fast operation', async () => {
    const deadline = createScenarioDeadline(Date.now(), 1_000);
    await expect(deadline.within('fast op', async () => 42)).resolves.toBe(42);
  });

  it('rejects with the label once the scenario budget has already expired', async () => {
    const deadline = createScenarioDeadline(Date.now() - 10, 5);
    await expect(deadline.within('late op', async () => 1)).rejects.toThrow(
      /scenario deadline exceeded before late op/
    );
  });

  it('rejects and aborts with the deadline reason when the operation hangs', async () => {
    const deadline = createScenarioDeadline(Date.now(), 30);
    let aborted = false;
    let reason: unknown;
    await expect(
      deadline.within('slow op', signal => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reason = signal.reason;
        });
        return new Promise<never>(() => {});
      })
    ).rejects.toThrow(/scenario deadline exceeded during slow op/);
    expect(aborted).toBe(true);
    expect(reason).toBeInstanceOf(Error);
  });

  it('caps a single operation with budgetMs without extending the deadline', async () => {
    const deadline = createScenarioDeadline(Date.now(), 10_000);
    const startedAt = Date.now();
    await expect(
      deadline.within('capped op', () => new Promise<never>(() => {}), 20)
    ).rejects.toThrow(/scenario deadline exceeded during capped op/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('sendTurn', () => {
  it('treats turnBudgetMs as one cumulative turn budget across its phases', async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.openConnectedStream.mockResolvedValue(stream);
    mocks.sendMessage.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ messageId: 'message_1' }), 400))
    );
    // Withhold the terminal until the stream's own timeout so the terminal
    // phase, not an instant null, is what the remaining turn budget bounds.
    stream.waitForTerminal.mockImplementation(
      (timeoutMs: number) =>
        new Promise<StreamEvent | null>(resolve => {
          setTimeout(() => resolve(null), timeoutMs);
        })
    );

    const deadline = createScenarioDeadline(Date.now(), 30_000);
    const pending = sendTurn(deadline, CONFIG, 'workspace_1', 'echo:x', 'turn', 1_000);
    const rejection = expect(pending).rejects.toThrow(/did not reach a terminal/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    const terminalTimeout = stream.waitForTerminal.mock.calls[0]?.[0];
    expect(terminalTimeout).toBeGreaterThan(0);
    expect(terminalTimeout).toBeLessThanOrEqual(600);
    expect(stream.close).toHaveBeenCalled();
  });

  it('does not revive an exhausted turn budget for a later phase', async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    mocks.openConnectedStream.mockResolvedValue(stream);
    mocks.sendMessage.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ messageId: 'message_1' }), 10))
    );
    // The terminal arrives after the turn deadline, so the durable phase must
    // fail closed rather than receive a fresh positive allowance.
    stream.waitForTerminal.mockImplementation(
      () =>
        new Promise<StreamEvent | null>(resolve => {
          setTimeout(() => resolve(terminalEvent()), 500);
        })
    );

    const deadline = createScenarioDeadline(Date.now(), 30_000);
    const pending = sendTurn(deadline, CONFIG, 'workspace_1', 'echo:x', 'turn', 400);
    const rejection = expect(pending).rejects.toThrow(
      /turn: turn budget 400ms exhausted before durable/
    );
    await vi.advanceTimersByTimeAsync(600);
    await rejection;

    expect(mocks.getMessageResult).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalled();
  });

  it('takes every phase budget from the scenario deadline when no turn budget is given', async () => {
    const stream = fakeStream(terminalEvent());
    mocks.openConnectedStream.mockResolvedValue(stream);
    mocks.sendMessage.mockResolvedValue({ messageId: 'message_1' });
    mocks.getMessageResult.mockResolvedValue({ status: 'completed' });

    const remainingByLabel: Record<string, number> = {
      'turn stream': 1_111,
      'turn send': 2_222,
      'turn terminal': 3_333,
      'turn durable': 4_444,
    };
    const withinCalls: Array<{ label: string; budgetMs: number | undefined }> = [];
    const deadline: ScenarioDeadline = {
      deadlineAt: Date.now() + 60_000,
      remaining: label => {
        const value = remainingByLabel[label];
        if (value === undefined) throw new Error(`unexpected remaining label: ${label}`);
        return value;
      },
      within: (label, operation, budgetMs) => {
        withinCalls.push({ label, budgetMs });
        return operation(new AbortController().signal);
      },
    };

    const turn = await sendTurn(deadline, CONFIG, 'workspace_1', 'echo:x', 'turn');

    expect(withinCalls).toEqual([
      { label: 'turn stream', budgetMs: 1_111 },
      { label: 'turn send', budgetMs: 2_222 },
      { label: 'turn durable status', budgetMs: 4_444 },
    ]);
    expect(stream.waitForTerminal).toHaveBeenCalledWith(3_333, 'message_1');
    expect(turn.terminal.streamEventType).toBe('cloud.message.completed');
  });
});

describe('bootToCompletion', () => {
  it('closes the internally acquired stream when the durable read does not complete', async () => {
    const stream = fakeStream(completedEvent('message_1'));
    mocks.openConnectedStream.mockResolvedValue(stream);
    mocks.getSessionSnapshot.mockResolvedValue({ initialMessageId: 'message_1' });
    mocks.getMessageResult.mockResolvedValue({ status: 'failed' });

    const deadline = createScenarioDeadline(Date.now(), 30_000);
    await expect(bootToCompletion(deadline, CONFIG, SESSION, 'boot')).rejects.toThrow(
      /boot durable status=failed/
    );
    expect(stream.close).toHaveBeenCalledTimes(1);
  });
});

describe('startPacedHoldTurn', () => {
  it('closes the stream it opened when the baseline fetch rejects', async () => {
    const stream = fakeStream();
    mocks.openConnectedStream.mockResolvedValue(stream);
    mocks.fetchFakeRequests.mockRejectedValue(new Error('baseline unavailable'));

    const deadline = createScenarioDeadline(Date.now(), 30_000);
    await expect(
      startPacedHoldTurn({
        deadline,
        config: CONFIG,
        cloudAgentSessionId: 'workspace_1',
        directive: 'slow:2:50',
        label: 'hold',
        budgetMs: 10_000,
      })
    ).rejects.toThrow('baseline unavailable');
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('leaves a caller-supplied stream caller-owned when the baseline fetch rejects', async () => {
    const stream = fakeStream();
    mocks.fetchFakeRequests.mockRejectedValue(new Error('baseline unavailable'));

    const deadline = createScenarioDeadline(Date.now(), 30_000);
    await expect(
      startPacedHoldTurn({
        deadline,
        config: CONFIG,
        cloudAgentSessionId: 'workspace_1',
        directive: 'slow:2:50',
        label: 'hold',
        budgetMs: 10_000,
        stream,
      })
    ).rejects.toThrow('baseline unavailable');
    expect(stream.close).not.toHaveBeenCalled();
    expect(mocks.openConnectedStream).not.toHaveBeenCalled();
  });
});

describe('requireContainer', () => {
  it('returns null when the capability is absent', async () => {
    await expect(requireContainer(undefined, SESSION, 5)).resolves.toBeNull();
  });

  it('propagates a present capability failure instead of swallowing it', async () => {
    const sessionSandbox: SessionSandboxObservation = {
      waitForContainer: () => {
        throw new Error('container wait failed');
      },
      currentContainer: vi.fn(async () => null),
    };

    await expect(requireContainer(sessionSandbox, SESSION, 7)).rejects.toThrow(
      'container wait failed'
    );
  });

  it('delegates to the capability when present', async () => {
    const waitForContainer = vi.fn(async () => 'container_1');
    const sessionSandbox: SessionSandboxObservation = {
      waitForContainer,
      currentContainer: vi.fn(async () => 'container_1'),
    };

    await expect(requireContainer(sessionSandbox, SESSION, 7)).resolves.toBe('container_1');
    expect(waitForContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAgentSessionId: SESSION.cloudAgentSessionId,
        kiloSessionId: SESSION.kiloSessionId,
        timeoutMs: 7,
      })
    );
  });
});

describe('waitForPresentAllocation', () => {
  it('acquires a present reference through the bounded wait, not a single current read', async () => {
    const waitForContainer = vi.fn(async () => 'container_1');
    const currentContainer = vi.fn(async () => 'container_1');
    const deadline = createScenarioDeadline(Date.now(), 60_000);

    await expect(
      waitForPresentAllocation(
        deadline,
        { waitForContainer, currentContainer },
        SESSION,
        'boot',
        30_000
      )
    ).resolves.toBe('container_1');

    expect(waitForContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudAgentSessionId: SESSION.cloudAgentSessionId,
        kiloSessionId: SESSION.kiloSessionId,
        timeoutMs: 30_000,
      })
    );
    expect(currentContainer).not.toHaveBeenCalled();
  });

  it('caps the wait at the remaining scenario budget', async () => {
    const waitForContainer = vi.fn(async (_input: { timeoutMs: number }) => 'container_1');
    const deadline = createScenarioDeadline(Date.now(), 1_000);

    await waitForPresentAllocation(
      deadline,
      { waitForContainer, currentContainer: vi.fn(async () => null) },
      SESSION,
      'boot',
      30_000
    );

    const input = waitForContainer.mock.calls[0]?.[0];
    expect(input?.timeoutMs).toBeGreaterThan(0);
    expect(input?.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it('returns null when the capability finds no reference within its budget', async () => {
    const deadline = createScenarioDeadline(Date.now(), 60_000);

    await expect(
      waitForPresentAllocation(
        deadline,
        { waitForContainer: vi.fn(async () => null), currentContainer: vi.fn(async () => null) },
        SESSION,
        'boot',
        5
      )
    ).resolves.toBeNull();
  });
});

describe('trackStartedSession', () => {
  it('binds the reported id before the start returns and keeps the prior hook', () => {
    const prior: string[] = [];
    const tracked: string[] = [];
    const wrapped = trackStartedSession({ ...CONFIG, onSessionCreated: id => prior.push(id) }, id =>
      tracked.push(id)
    );

    // The legacy prepare path reports the id before initiation; a later failure
    // must still find it in `tracked`.
    wrapped.onSessionCreated?.('workspace_prepared');

    expect(tracked).toEqual(['workspace_prepared']);
    expect(prior).toEqual(['workspace_prepared']);
    expect(wrapped).not.toBe(CONFIG);
  });

  it('works when the config has no prior onSessionCreated hook', () => {
    const tracked: string[] = [];
    trackStartedSession(CONFIG, id => tracked.push(id)).onSessionCreated?.('workspace_1');
    expect(tracked).toEqual(['workspace_1']);
  });
});

describe('createOwnedSessionRegistry', () => {
  it('composes onSessionCreated and returns newest-first cleanup entries', () => {
    const prior: string[] = [];
    const registry = createOwnedSessionRegistry(
      {
        ...CONFIG,
        onSessionCreated: id => prior.push(id),
      },
      async () => {}
    );

    registry.config.onSessionCreated?.('workspace_root');
    registry.register({ cloudAgentSessionId: 'workspace_root', kiloSessionId: 'ses_root' });
    registry.register({ cloudAgentSessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' });
    registry.register({ cloudAgentSessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' });

    expect(prior).toEqual(['workspace_root']);
    expect(registry.entries()).toEqual([
      { sessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' },
      { sessionId: 'workspace_root', kiloSessionId: 'ses_root' },
    ]);
  });

  it('keeps an id recorded by onSessionCreated when the create later throws', () => {
    const registry = createOwnedSessionRegistry(CONFIG, async () => {});

    const createThatRegistersThenThrows = (): never => {
      registry.config.onSessionCreated?.('workspace_leaked');
      throw new Error('wrong-plane session created');
    };

    expect(createThatRegistersThenThrows).toThrow('wrong-plane session created');
    expect(registry.entries()).toEqual([
      { sessionId: 'workspace_leaked', kiloSessionId: undefined },
    ]);
  });

  it('cleans each owned id once, newest first', async () => {
    const cleaned: string[] = [];
    const registry = createOwnedSessionRegistry(CONFIG, async (_config, sessionId) => {
      cleaned.push(sessionId);
    });
    registry.register({ cloudAgentSessionId: 'workspace_root', kiloSessionId: 'ses_root' });
    registry.register({ cloudAgentSessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' });

    await registry.cleanup('scenario');
    await registry.cleanup('scenario');

    expect(cleaned).toEqual(['workspace_sibling', 'workspace_root']);
  });

  it('does not clean an id twice through cleanupLate', async () => {
    const cleaned: string[] = [];
    const registry = createOwnedSessionRegistry(CONFIG, async (_config, sessionId) => {
      cleaned.push(sessionId);
    });
    registry.register({ cloudAgentSessionId: 'workspace_shared', kiloSessionId: 'ses_shared' });

    await registry.cleanup('scenario');
    await registry.cleanupLate(
      { cloudAgentSessionId: 'workspace_shared', kiloSessionId: 'ses_shared' },
      'scenario'
    );
    await registry.cleanup('scenario');

    expect(cleaned).toEqual(['workspace_shared']);
  });
});

describe('trackCreations late-create ownership', () => {
  it('cleans an id from a create that settles after the grace', async () => {
    const cleaned: Array<{ sessionId: string; kiloSessionId: string | undefined }> = [];
    const owned = createOwnedSessionRegistry(
      CONFIG,
      async (_config, sessionId, _label, kiloSessionId) => {
        cleaned.push({ sessionId, kiloSessionId });
      }
    );
    const deadline = createScenarioDeadline(Date.now(), 5_000);
    const creations = trackCreations<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      deadline,
      owned,
      'late-scenario'
    );

    let resolveCreate!: (value: { cloudAgentSessionId: string; kiloSessionId?: string }) => void;
    const pending = new Promise<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      resolve => {
        resolveCreate = resolve;
      }
    );
    void creations.track(pending);

    await expect(creations.settleAll(10)).resolves.toEqual([]);
    expect(cleaned).toEqual([]);

    resolveCreate({ cloudAgentSessionId: 'workspace_late', kiloSessionId: 'ses_late' });

    await vi.waitFor(() => expect(cleaned).toHaveLength(1));
    expect(cleaned[0]).toEqual({ sessionId: 'workspace_late', kiloSessionId: 'ses_late' });
  });

  it('cleans an id registered by a create that rejects after the grace', async () => {
    const cleaned: string[] = [];
    const owned = createOwnedSessionRegistry(CONFIG, async (_config, sessionId) => {
      cleaned.push(sessionId);
    });
    const deadline = createScenarioDeadline(Date.now(), 5_000);
    const creations = trackCreations<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      deadline,
      owned,
      'late-scenario'
    );

    let rejectCreate!: (error: unknown) => void;
    const pending = new Promise<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      (_resolve, reject) => {
        rejectCreate = reject;
      }
    );
    void creations.track(pending);

    await expect(creations.settleAll(10)).resolves.toEqual([]);
    expect(cleaned).toEqual([]);

    // `client.ts` invokes the composed `onSessionCreated` before its wrong-plane
    // assertion rejects the create, so the id is registered but never returned.
    owned.config.onSessionCreated?.('workspace_registered');
    rejectCreate(new Error('wrong-plane session created'));

    await vi.waitFor(() => expect(cleaned).toEqual(['workspace_registered']));
    await owned.cleanup('late-scenario');
    expect(cleaned).toEqual(['workspace_registered']);
  });

  it('performs no cleanup when a late create rejects without registering an id', async () => {
    const cleaned: string[] = [];
    const owned = createOwnedSessionRegistry(CONFIG, async (_config, sessionId) => {
      cleaned.push(sessionId);
    });
    const cleanupSpy = vi.spyOn(owned, 'cleanup');
    const deadline = createScenarioDeadline(Date.now(), 5_000);
    const creations = trackCreations<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      deadline,
      owned,
      'late-scenario'
    );

    let rejectCreate!: (error: unknown) => void;
    const pending = new Promise<{ cloudAgentSessionId: string; kiloSessionId?: string }>(
      (_resolve, reject) => {
        rejectCreate = reject;
      }
    );
    void creations.track(pending);

    await creations.settleAll(10);
    rejectCreate(new Error('create failed before registration'));

    // The handler ran its deduplicated cleanup over an empty registry.
    await vi.waitFor(() => expect(cleanupSpy).toHaveBeenCalledTimes(1));
    expect(cleaned).toEqual([]);
  });
});

describe('sessionSandboxObservation', () => {
  it('throws when the environment has no sessionSandbox capability', () => {
    expect(() =>
      sessionSandboxObservation({ profile: 'deployed', requireControlPlaneSession: true })
    ).toThrow(/sessionSandbox capability is required/);
  });

  it('returns the capability when present', () => {
    const capability: SessionSandboxObservation = {
      waitForContainer: vi.fn(async () => null),
      currentContainer: vi.fn(async () => null),
    };
    expect(
      sessionSandboxObservation({
        profile: 'deployed',
        requireControlPlaneSession: true,
        sessionSandbox: capability,
      })
    ).toBe(capability);
  });
});
