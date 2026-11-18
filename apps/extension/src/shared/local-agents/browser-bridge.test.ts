/* eslint-disable eslint/max-statements, max-lines, max-lines-per-function, max-expects, require-await, typescript/require-await, typescript-eslint/consistent-type-definitions -- one fake runtime serves every protocol branch, and its recorders read as one table */
import { describe, expect, it } from 'vitest';
import { AGENT_TAB_OUTSIDE_GROUP_ERROR } from '../browser-agent-checks';
import { TAB_BUSY_ERROR, TAB_TAKEN_ERROR } from '../browser-caller';
import type { BrowserCaller } from '../browser-caller';
import type { BrowserToolRunInput, BrowserToolRunOutcome } from '../browser-runtime';
import type { BrowserTabGroupSessionSummary } from '../browser-tab-groups';
import { BROWSER_TOOL_CONTRACT_SHA } from './envelope';
import { createRuntimeBrowserBridge } from './browser-bridge';
import type { LocalAgentBrowserBridge, LocalAgentBrowserRuntime } from './browser-bridge';
import { LOCAL_AGENT_ERROR_CODES } from './jsonrpc';

const CONTROLLER = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const HANDLE = '11111111-2222-4333-8444-555555555555';
const SECOND_HANDLE = '99999999-8888-4777-8666-555555555555';

type FakeRuntime = {
  readonly closed: string[];
  readonly disposed: string[];
  readonly opened: { controllerId: string; sessionHandle: string; title: string }[];
  readonly released: string[];
  readonly run: BrowserToolRunInput[];
  readonly runtime: LocalAgentBrowserRuntime;
  readonly sessions: Map<string, { ended: boolean; tabs: number[] }>;
};

const callerKey = (caller: BrowserCaller): string =>
  caller.kind === 'agent' ? `${caller.controllerId}:${caller.sessionHandle}` : caller.kind;

const createFakeRuntime = (
  options: {
    readonly outcome?: ((input: BrowserToolRunInput) => BrowserToolRunOutcome) | undefined;
    readonly share?: { readonly groupId?: number | undefined; readonly tabId: number } | undefined;
  } = {}
): FakeRuntime => {
  const sessions = new Map<string, { ended: boolean; tabs: number[] }>();
  const opened: { controllerId: string; sessionHandle: string; title: string }[] = [];
  const closed: string[] = [];
  const disposed: string[] = [];
  const released: string[] = [];
  const run: BrowserToolRunInput[] = [];

  const summaries = (): BrowserTabGroupSessionSummary[] =>
    [...sessions.entries()].map(([sessionHandle, session]) => ({
      ended: session.ended,
      sessionHandle,
      tabs: [...session.tabs],
      title: 'Work',
    }));

  const runtime: LocalAgentBrowserRuntime = {
    adoptEnded: async ({ sessionHandle }) => {
      const adopted = [...sessions.entries()].find(([, session]) => session.ended);

      if (adopted === undefined) {
        return {};
      }

      const [endedHandle, state] = adopted;
      const existing = sessions.get(sessionHandle);

      sessions.delete(endedHandle);
      sessions.set(sessionHandle, {
        ended: false,
        tabs: [...(existing?.tabs ?? []), ...state.tabs],
      });

      return {};
    },
    closeSession: async ({ sessionHandle }) => {
      const session = sessions.get(sessionHandle);

      if (session !== undefined) {
        session.ended = true;
      }

      closed.push(sessionHandle);
    },
    disposeCaller: (caller: BrowserCaller) => {
      disposed.push(callerKey(caller));

      return 1;
    },
    listSessions: () => summaries(),
    openSession: async input => {
      // Like the controller: reopening a handle revives it with the tabs it already had.
      const existing = sessions.get(input.sessionHandle);

      sessions.set(input.sessionHandle, { ended: false, tabs: [...(existing?.tabs ?? [])] });
      opened.push(input);

      return {};
    },
    releaseCaller: (caller: BrowserCaller) => {
      released.push(callerKey(caller));

      return 1;
    },
    runTool: async input => {
      run.push(input);

      return options.outcome?.(input) ?? { kind: 'result', result: { ok: true, value: 'ok' } };
    },
    shareActiveTab: async ({ sessionHandle }) => {
      const shared = options.share ?? { tabId: 5 };
      sessions.get(sessionHandle)?.tabs.push(shared.tabId);

      return {
        tabId: shared.tabId,
        ...(shared.groupId === undefined ? {} : { groupId: shared.groupId }),
      };
    },
  };

  return { closed, disposed, opened, released, run, runtime, sessions };
};

const openAndShare = async (bridge: LocalAgentBrowserBridge, sessionHandle = HANDLE) => {
  await bridge.openSession({ controllerId: CONTROLLER, sessionHandle, title: 'Work' });
  await bridge.shareActiveTab({ controllerId: CONTROLLER, sessionHandle });
};

const snapshotParams = (sessionHandle = HANDLE) => ({
  arguments: {},
  authorized: [{ class: 'read', origin: 'https://app.example.com' }],
  name: 'browser_snapshot',
  sessionHandle,
});

describe('local agent browser bridge', () => {
  it('opens a session, runs the call on its group tab, and releases the lease', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });
    await bridge.shareActiveTab({ controllerId: CONTROLLER, sessionHandle: HANDLE });

    const result = await bridge.callTool(CONTROLLER, snapshotParams());

    expect(fake.opened).toStrictEqual([
      { controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' },
    ]);
    expect(fake.run).toHaveLength(1);
    expect(fake.run[0]).toMatchObject({
      arguments: {},
      caller: { controllerId: CONTROLLER, kind: 'agent', sessionHandle: HANDLE },
      tabId: 5,
      toolName: 'browser_snapshot',
    });
    expect(fake.run[0]?.agent).toStrictEqual({
      authorized: [{ class: 'read', origin: 'https://app.example.com' }],
    });
    expect(result).toStrictEqual({ content: [{ text: 'ok', type: 'text' }] });
    // Turn end: the next caller must not queue behind this call's lease.
    expect(fake.released).toStrictEqual([`${CONTROLLER}:${HANDLE}`]);
  });

  it('prefers the browser\u2019s active tab when the session owns it', async () => {
    const fake = createFakeRuntime({ share: { tabId: 5 } });
    const bridge = createRuntimeBrowserBridge({
      activeTabId: async () => 9,
      runtime: () => fake.runtime,
    });

    await openAndShare(bridge);
    fake.sessions.get(HANDLE)?.tabs.push(9);
    await bridge.callTool(CONTROLLER, snapshotParams());

    expect(fake.run[0]?.tabId).toBe(9);
  });

  it('falls back to the newest group tab when the active tab is outside the session', async () => {
    const fake = createFakeRuntime({ share: { tabId: 5 } });
    const bridge = createRuntimeBrowserBridge({
      activeTabId: async () => 7,
      runtime: () => fake.runtime,
    });

    await openAndShare(bridge);
    fake.sessions.get(HANDLE)?.tabs.push(8);
    await bridge.callTool(CONTROLLER, snapshotParams());

    expect(fake.run[0]?.tabId).toBe(8);
  });

  it('refuses a call for a session with no tab', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
    expect(fake.run).toStrictEqual([]);
  });

  it('refuses a session handle that was never opened', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
  });

  it('maps needs_permission with its items and step token onto -32010', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        items: [
          { class: 'sensitive', origin: 'https://app.example.com', reason: 'typing a password' },
        ],
        kind: 'needs_permission',
        result: { error: 'needs permission', ok: false },
        stepToken: 'step-1',
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: {
        items: [
          { class: 'sensitive', origin: 'https://app.example.com', reason: 'typing a password' },
        ],
        stepToken: 'step-1',
      },
    });
  });

  it('maps origin_changed onto -32012 with both origins', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        from: 'https://app.example.com',
        kind: 'origin_changed',
        result: { error: 'origin changed', ok: false },
        to: 'https://other.example.com',
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.originChanged,
      data: { from: 'https://app.example.com', to: 'https://other.example.com' },
    });
  });

  it('maps a busy tab, a taken tab and a refused group onto their codes', async () => {
    const withError = (error: string) => {
      const fake = createFakeRuntime({
        outcome: () => ({ kind: 'result', result: { error, ok: false } }),
      });

      return createRuntimeBrowserBridge({ runtime: () => fake.runtime });
    };

    const busy = withError(TAB_BUSY_ERROR);
    await openAndShare(busy);
    await expect(busy.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.tabBusy,
    });

    const taken = withError(TAB_TAKEN_ERROR);
    await openAndShare(taken);
    await expect(taken.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.tabTaken,
    });

    const outside = withError(AGENT_TAB_OUTSIDE_GROUP_ERROR);
    await openAndShare(outside);
    await expect(outside.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
  });

  it('returns an ordinary tool failure as an error result, not a protocol error', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({ kind: 'result', result: { error: 'No element matches e99.', ok: false } }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).resolves.toStrictEqual({
      content: [{ text: 'No element matches e99.', type: 'text' }],
      isError: true,
    });
  });

  it('carries the withheld frame origins in _meta', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        kind: 'result',
        result: { ok: true, value: 'snapshot' },
        withheldFrames: ['https://pay.example.com'],
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).resolves.toStrictEqual({
      _meta: { withheldFrames: ['https://pay.example.com'] },
      content: [{ text: 'snapshot', type: 'text' }],
    });
  });

  it('sends a screenshot as an image plus its text line', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        kind: 'result',
        result: {
          ok: true,
          value: {
            dataUrl: 'data:image/png;base64,aGVsbG8=',
            mediaType: 'png',
            text: 'Screenshot captured.',
          },
        },
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).resolves.toStrictEqual({
      content: [
        { data: 'aGVsbG8=', mimeType: 'png', type: 'image' },
        { text: 'Screenshot captured.', type: 'text' },
      ],
    });
  });

  it('serializes an object value as the text the model reads', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        kind: 'result',
        result: { ok: true, value: { selected: true, tabId: 5 } },
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).resolves.toStrictEqual({
      content: [{ text: '{"selected":true,"tabId":5}', type: 'text' }],
    });
  });

  it('ends the session on close and refuses the next call as user_stopped', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);
    await bridge.closeSession({ controllerId: CONTROLLER, sessionHandle: HANDLE });

    expect(fake.closed).toStrictEqual([HANDLE]);
    // The lease and the refs go with the session; the group keeps its tabs for adoption.
    expect(fake.disposed).toStrictEqual([`${CONTROLLER}:${HANDLE}`]);
    expect(fake.sessions.get(HANDLE)?.tabs).toStrictEqual([5]);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.userStopped,
    });
  });

  it('ends every session on Stop all', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge, HANDLE);
    await openAndShare(bridge, SECOND_HANDLE);
    await bridge.endSessions([
      { controllerId: CONTROLLER, sessionHandle: HANDLE },
      { controllerId: CONTROLLER, sessionHandle: SECOND_HANDLE },
    ]);

    expect(fake.closed.toSorted()).toStrictEqual([HANDLE, SECOND_HANDLE].toSorted());
    expect(fake.disposed).toHaveLength(2);
    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.userStopped,
    });
  });

  it('reports user_stopped for a call Stop all ended while it ran', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const fake = createFakeRuntime();
    const { runTool } = fake.runtime;
    const bridge = createRuntimeBrowserBridge({
      runtime: () => ({
        ...fake.runtime,
        runTool: async input => {
          await promise;

          return runTool(input);
        },
      }),
    });

    await openAndShare(bridge);
    const call = bridge.callTool(CONTROLLER, snapshotParams());

    await bridge.endSessions([{ controllerId: CONTROLLER, sessionHandle: HANDLE }]);
    resolve();

    await expect(call).rejects.toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.userStopped });
  });

  it('lists the contract tools with their read-only flag', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });
    const list = await bridge.listTools();

    expect(list['contractSha']).toBe(BROWSER_TOOL_CONTRACT_SHA);
    expect(list['tools']).toContainEqual(
      expect.objectContaining({ name: 'browser_snapshot', readOnly: true })
    );
  });

  it('refuses a share when the browser has no active tab', async () => {
    const fake = createFakeRuntime({ share: { tabId: 0 } });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    await expect(
      bridge.shareActiveTab({ controllerId: CONTROLLER, sessionHandle: HANDLE })
    ).rejects.toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.blocked });
  });

  it('clears the stopped state when a fresh session adopts an ended group', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge, HANDLE);
    await bridge.closeSession({ controllerId: CONTROLLER, sessionHandle: HANDLE });
    await bridge.openSession({
      controllerId: CONTROLLER,
      sessionHandle: SECOND_HANDLE,
      title: 'Next',
    });

    // The new session starts with no tab of its own; the ended group is what it adopts.
    await expect(bridge.callTool(CONTROLLER, snapshotParams(SECOND_HANDLE))).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
    await expect(
      bridge.adopt({ controllerId: CONTROLLER, sessionHandle: SECOND_HANDLE })
    ).resolves.toStrictEqual({});

    await expect(bridge.callTool(CONTROLLER, snapshotParams(SECOND_HANDLE))).resolves.toMatchObject(
      { content: [{ type: 'text' }] }
    );
  });
});
