/* eslint-disable eslint/max-statements, max-lines, max-lines-per-function, max-expects, require-await, typescript/require-await, typescript-eslint/consistent-type-definitions -- one fake runtime serves every protocol branch, and its recorders read as one table */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AGENT_TAB_OUTSIDE_GROUP_ERROR, SENSITIVE_REASON } from '../browser-agent-checks';
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
/** The token the runtime hands back for a stopped download, which the CLI's repeat carries. */
const APPROVAL_TOKEN = 'step-token-1';

type FakeRuntime = {
  readonly closed: string[];
  readonly disposed: string[];
  readonly disposedTabs: number[];
  readonly opened: { controllerId: string; sessionHandle: string; title: string }[];
  readonly ownTabs: { sessionHandle: string }[];
  readonly released: string[];
  readonly releasedTabs: { caller: string; tabId: number }[];
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
    /** What `tabInfo` reports; the default is a tab that finished its navigation. */
    readonly tabInfo?: { readonly title: string; readonly url: string } | undefined;
  } = {}
): FakeRuntime => {
  const sessions = new Map<string, { ended: boolean; tabs: number[] }>();
  const opened: { controllerId: string; sessionHandle: string; title: string }[] = [];
  const closed: string[] = [];
  const disposed: string[] = [];
  const released: string[] = [];
  const releasedTabs: { caller: string; tabId: number }[] = [];
  const run: BrowserToolRunInput[] = [];
  const ownTabs: { sessionHandle: string }[] = [];
  const disposedTabs: number[] = [];

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
    disposeTab: async (tabId: number) => {
      disposedTabs.push(tabId);

      for (const session of sessions.values()) {
        session.tabs = session.tabs.filter(id => id !== tabId);
      }
    },
    listSessions: () => summaries(),
    openSession: async input => {
      // Like the controller: reopening a handle revives it with the tabs it already had.
      const existing = sessions.get(input.sessionHandle);

      sessions.set(input.sessionHandle, { ended: false, tabs: [...(existing?.tabs ?? [])] });
      opened.push(input);

      return {};
    },
    openSessionTab: async input => {
      ownTabs.push(input);

      const tabId = 77;

      sessions.get(input.sessionHandle)?.tabs.push(tabId);

      return { groupId: 42, tabId, title: '', url: 'about:blank' };
    },
    releaseCaller: (caller: BrowserCaller) => {
      released.push(callerKey(caller));

      return 1;
    },
    releaseTab: ({ caller, tabId }) => {
      releasedTabs.push({ caller: callerKey(caller), tabId });
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
    tabInfo: async () =>
      options.tabInfo ?? { title: 'Started', url: 'https://app.example.com/next' },
  };

  return {
    closed,
    disposed,
    disposedTabs,
    opened,
    ownTabs,
    released,
    releasedTabs,
    run,
    runtime,
    sessions,
  };
};

const openAndShare = async (bridge: LocalAgentBrowserBridge, sessionHandle = HANDLE) => {
  await bridge.openSession({ controllerId: CONTROLLER, sessionHandle, title: 'Work' });
  await bridge.shareActiveTab({ controllerId: CONTROLLER, sessionHandle });
};

const refusalSchema = z.object({
  code: z.number(),
  data: z.record(z.string(), z.unknown()).optional(),
  message: z.string(),
});

/** The protocol error a bridge call rejected with, parsed so the test reads a checked shape. */
const rejectionOf = async (
  call: Promise<unknown>
): Promise<z.infer<typeof refusalSchema> | undefined> => {
  try {
    await call;

    return undefined;
  } catch (error) {
    const parsed = refusalSchema.safeParse(error);

    return parsed.success ? parsed.data : undefined;
  }
};

const navigateParams = (sessionHandle = HANDLE) => ({
  arguments: { url: 'https://app.example.com/next' },
  authorized: [{ class: 'navigate', origin: 'https://app.example.com' }],
  name: 'browser_navigate',
  sessionHandle,
});

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
    // Turn end: only this call's tab is released, so the session's other tabs keep their leases.
    expect(fake.releasedTabs).toStrictEqual([{ caller: `${CONTROLLER}:${HANDLE}`, tabId: 5 }]);
    expect(fake.released).toStrictEqual([]);
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

  it('blocks a tool that cannot start a tab when the session has none', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const blocked = await rejectionOf(bridge.callTool(CONTROLLER, snapshotParams()));

    expect(blocked).toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.blocked });
    expect(blocked?.message).toBe('This session has no tab yet. Navigate to a page first.');
    expect(fake.run).toStrictEqual([]);
    expect(fake.ownTabs).toStrictEqual([]);
  });

  it('opens one inactive tab for a navigate on an empty session and keeps the user\u2019s tab', async () => {
    const fake = createFakeRuntime();
    const activeTabId = vi.fn(async () => 5);
    const bridge = createRuntimeBrowserBridge({ activeTabId, runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const result = await bridge.callTool(CONTROLLER, navigateParams());

    // The tab opens blank and grouped, and the call navigates it.
    // A tab opened at the destination would let Chrome start a download before the gate ran.
    expect(fake.ownTabs).toStrictEqual([{ sessionHandle: HANDLE }]);
    expect(fake.run).toHaveLength(1);
    expect(fake.run[0]).toMatchObject({
      arguments: { url: 'https://app.example.com/next' },
      caller: { sessionHandle: HANDLE },
      tabId: 77,
      toolName: 'browser_navigate',
    });
    expect(result).toStrictEqual({ content: [{ text: 'ok', type: 'text' }] });
    // A tab the agent opens for itself is not a share: the user's active tab is never even read.
    expect(activeTabId).not.toHaveBeenCalled();
    expect(fake.disposedTabs).toStrictEqual([]);
  });

  it('refuses a first navigate to a URL no grant can name and opens nothing', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const blocked = await rejectionOf(
      bridge.callTool(CONTROLLER, {
        ...navigateParams(),
        arguments: { url: 'data:text/html,<h1>off-grant</h1>' },
        authorized: [],
      })
    );

    expect(blocked).toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.blocked });
    // No grant can cover a page the debugger could not attach to, so no tab is left behind.
    expect(fake.ownTabs).toStrictEqual([]);
    expect(fake.run).toStrictEqual([]);
  });

  it('opens no tab at all when the navigate is refused', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    await expect(
      bridge.callTool(CONTROLLER, {
        ...navigateParams(),
        authorized: [{ class: 'read', origin: 'https://app.example.com' }],
      })
    ).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: { items: [{ class: 'navigate', origin: 'https://app.example.com' }] },
    });
    // The gate decides before any tab exists, so a refusal leaves nothing behind.
    expect(fake.ownTabs).toStrictEqual([]);
    expect(fake.run).toStrictEqual([]);
  });

  it('refuses a first navigate with no URL rather than opening a blank tab', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const blocked = await rejectionOf(
      bridge.callTool(CONTROLLER, { ...navigateParams(), arguments: {} })
    );

    expect(blocked).toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.blocked });
    expect(fake.ownTabs).toStrictEqual([]);
  });

  it('opens the tab browser_tabs new asks for on an empty session', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const result = await bridge.callTool(CONTROLLER, {
      arguments: { action: 'new', url: 'https://app.example.com/start' },
      authorized: [{ class: 'navigate', origin: 'https://app.example.com' }],
      name: 'browser_tabs',
      sessionHandle: HANDLE,
    });

    // The tab opens blank and grouped, and the requested url loads through the guarded navigate path.
    expect(fake.ownTabs).toStrictEqual([{ sessionHandle: HANDLE }]);
    expect(fake.run).toHaveLength(1);
    expect(fake.run[0]).toMatchObject({
      arguments: { url: 'https://app.example.com/start' },
      tabId: 77,
      toolName: 'browser_navigate',
    });
    expect(result).toStrictEqual({
      content: [
        {
          // The payload describes the tab after its navigation.
          text: JSON.stringify({
            selected: true,
            tabId: 77,
            title: 'Started',
            url: 'https://app.example.com/next',
          }),
          type: 'text',
        },
      ],
    });
  });

  it('runs the approved repeat of browser_tabs new as the navigate it asked for', async () => {
    let calls = 0;
    const fake = createFakeRuntime({
      outcome: () => {
        calls += 1;

        return calls === 1
          ? {
              afterAction: true,
              items: [
                {
                  class: 'sensitive',
                  origin: 'https://app.example.com',
                  reason: SENSITIVE_REASON.download,
                },
              ],
              kind: 'needs_permission',
              stepToken: APPROVAL_TOKEN,
            }
          : { kind: 'result', result: { ok: true, value: 'report.txt: The file was downloaded.' } };
      },
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const params = {
      arguments: { action: 'new', url: 'https://app.example.com/report.txt' },
      authorized: [{ class: 'navigate', origin: 'https://app.example.com' }],
      name: 'browser_tabs',
      sessionHandle: HANDLE,
    };

    // The first call opens the session's tab and loads the url under the guard, which stops the download and asks.
    const guarded = await rejectionOf(bridge.callTool(CONTROLLER, params));

    expect(guarded).toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: { afterAction: true, stepToken: APPROVAL_TOKEN },
    });
    expect(fake.run[0]).toMatchObject({
      arguments: { url: 'https://app.example.com/report.txt' },
      tabId: 77,
      toolName: 'browser_navigate',
    });

    // The CLI repeats the `browser_tabs` call it sent, not the navigate the token is bound to.
    // It has to run as that navigate on the tab the first call opened: a second tab would load the url unguarded.
    const approved = await bridge.callTool(CONTROLLER, {
      ...params,
      sensitive: [APPROVAL_TOKEN],
    });

    expect(fake.ownTabs).toHaveLength(1);
    expect(fake.run).toHaveLength(2);
    expect(fake.run[1]).toMatchObject({
      agent: { sensitive: [APPROVAL_TOKEN] },
      arguments: { url: 'https://app.example.com/report.txt' },
      tabId: 77,
      toolName: 'browser_navigate',
    });
    expect(approved).toStrictEqual({
      content: [{ text: 'report.txt: The file was downloaded.', type: 'text' }],
    });
  });

  it('reports the navigation that failed instead of a tab that never loaded', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        kind: 'result',
        result: { error: 'net::ERR_NAME_NOT_RESOLVED', ok: false },
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const result = await bridge.callTool(CONTROLLER, {
      arguments: { action: 'new', url: 'https://app.example.com/missing' },
      authorized: [{ class: 'navigate', origin: 'https://app.example.com' }],
      name: 'browser_tabs',
      sessionHandle: HANDLE,
    });

    // The tab exists, so `selected: true` would read as success; the model needs the load error it must act on.
    expect(result).toStrictEqual({
      content: [{ text: 'net::ERR_NAME_NOT_RESOLVED', type: 'text' }],
      isError: true,
    });
  });

  it('falls back to the opened url when the browser withholds it', async () => {
    const fake = createFakeRuntime({ tabInfo: { title: '', url: '' } });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const result = await bridge.callTool(CONTROLLER, {
      arguments: { action: 'new' },
      authorized: [],
      name: 'browser_tabs',
      sessionHandle: HANDLE,
    });

    // An `about:blank` tab reports no url without the `tabs` permission, which is not a tab at the empty url.
    expect(result).toStrictEqual({
      content: [
        {
          text: JSON.stringify({ selected: true, tabId: 77, title: '', url: 'about:blank' }),
          type: 'text',
        },
      ],
    });
  });

  it('refuses browser_tabs new without a navigate grant and opens nothing', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    await expect(
      bridge.callTool(CONTROLLER, {
        arguments: { action: 'new', url: 'https://pay.example.com/checkout' },
        authorized: [],
        name: 'browser_tabs',
        sessionHandle: HANDLE,
      })
    ).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: { items: [{ class: 'navigate', origin: 'https://pay.example.com' }] },
    });
    expect(fake.ownTabs).toStrictEqual([]);
  });

  it('refuses browser_tabs new at a URL no grant can name', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await bridge.openSession({ controllerId: CONTROLLER, sessionHandle: HANDLE, title: 'Work' });

    const blocked = await rejectionOf(
      bridge.callTool(CONTROLLER, {
        arguments: { action: 'new', url: 'view-source:https://app.example.com/' },
        authorized: [{ class: 'navigate', origin: 'https://app.example.com' }],
        name: 'browser_tabs',
        sessionHandle: HANDLE,
      })
    );

    expect(blocked).toMatchObject({ code: LOCAL_AGENT_ERROR_CODES.blocked });
    expect(fake.ownTabs).toStrictEqual([]);
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

    const refusal = await rejectionOf(bridge.callTool(CONTROLLER, snapshotParams()));

    expect(refusal).toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: {
        items: [
          { class: 'sensitive', origin: 'https://app.example.com', reason: 'typing a password' },
        ],
        stepToken: 'step-1',
      },
    });
    // A pre-action need carries no `afterAction`: the CLI may retry it.
    expect(refusal?.data?.['afterAction']).toBeUndefined();
  });

  it('marks a post-action refusal so the CLI never replays the action', async () => {
    const fake = createFakeRuntime({
      outcome: () => ({
        afterAction: true,
        items: [
          { class: 'sensitive', origin: 'https://app.example.com', reason: 'downloading a file' },
        ],
        kind: 'needs_permission',
        result: { error: 'needs permission', ok: false },
        stepToken: 'step-download',
      }),
    });
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });

    await openAndShare(bridge);

    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      data: {
        afterAction: true,
        items: [
          { class: 'sensitive', origin: 'https://app.example.com', reason: 'downloading a file' },
        ],
        stepToken: 'step-download',
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

  it('forgets a stopped handle after its time to live', async () => {
    let clock = 1000;
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ now: () => clock, runtime: () => fake.runtime });

    await openAndShare(bridge);
    await bridge.closeSession({ controllerId: CONTROLLER, sessionHandle: HANDLE });

    clock += 9 * 60_000;
    // Within ten minutes a late call still learns why it stopped.
    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.userStopped,
    });

    clock += 2 * 60_000;
    await expect(bridge.callTool(CONTROLLER, snapshotParams())).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
  });

  it('keeps the stopped-handle memory bounded', async () => {
    const fake = createFakeRuntime();
    const bridge = createRuntimeBrowserBridge({ runtime: () => fake.runtime });
    const handles = Array.from(
      { length: 300 },
      (_unused, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    );

    for (const sessionHandle of handles) {
      // eslint-disable-next-line no-await-in-loop -- one session lifecycle per handle, in order
      await bridge.openSession({ controllerId: CONTROLLER, sessionHandle, title: 'Work' });
      // eslint-disable-next-line no-await-in-loop -- see above
      await bridge.closeSession({ controllerId: CONTROLLER, sessionHandle });
    }

    // The oldest handle was evicted; the newest still answers for its own stop.
    await expect(bridge.callTool(CONTROLLER, snapshotParams(handles[0]))).rejects.toMatchObject({
      code: LOCAL_AGENT_ERROR_CODES.blocked,
    });
    await expect(bridge.callTool(CONTROLLER, snapshotParams(handles.at(-1)))).rejects.toMatchObject(
      { code: LOCAL_AGENT_ERROR_CODES.userStopped }
    );
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
