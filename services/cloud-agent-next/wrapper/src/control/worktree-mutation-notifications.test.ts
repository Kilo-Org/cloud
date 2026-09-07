import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type {
  BackgroundProcessInfo,
  Event,
  EventBackgroundProcessUpdated,
  EventInteractiveTerminalUpdated,
  EventMessagePartUpdated,
  InteractiveTerminalInfo,
  Pty,
  ToolState,
} from '@kilocode/sdk/v2';
import { WORKTREE_CHANGED_EVENT } from '../../../src/shared/worktree-changes-wire';
import type { WrapperKiloClient } from '../kilo-api';
import { eventKiloSessionId, sessionEventIdentity, unfilteredKiloEvents } from './feed';
import {
  buildHeartbeatPayload,
  createControlHandlerDeps,
  createSessionActivityRegistry,
  type HandlerSessionSnapshot,
} from './sandbox-control-handlers';
import {
  forgetAttachedRoot,
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
} from './session-directories';
import { fenceDirectoryOperations, resetDirectoryOperationState } from './worktree-operations';
import { createWorktreeMutationNotifications } from './worktree-mutation-notifications';
import type { WorktreeKiloRuntime } from './worktree-runtime';

const directory = '/worktree';
const fileEdited = { type: 'file.edited', properties: { file: '/worktree/file.ts' } };
const nextProperties = {
  timestamp: 1,
  sessionID: 'root',
  assistantMessageID: 'assistant',
  callID: 'call',
};

function toolEvent(state: ToolState): EventMessagePartUpdated {
  return {
    id: 'event',
    type: 'message.part.updated',
    properties: {
      sessionID: 'root',
      time: 1,
      part: {
        id: 'part',
        sessionID: 'root',
        messageID: 'assistant',
        type: 'tool',
        tool: 'mcp_arbitrary_mutation',
        callID: 'call',
        state,
      },
    },
  };
}

function backgroundEvent(
  status: BackgroundProcessInfo['status'],
  sessionID = 'root'
): EventBackgroundProcessUpdated {
  return {
    id: 'event',
    type: 'background_process.updated',
    properties: {
      scope: 'session',
      info: {
        id: 'process-not-a-session',
        sessionID,
        command: 'git add file.ts',
        cwd: directory,
        ports: [],
        status,
        lifetime: 'session',
        ready: false,
        output: 'process output must not be forwarded',
        time: { started: 1, updated: 2 },
      },
    },
  };
}

function interactiveEvent(
  status: InteractiveTerminalInfo['status'],
  sessionID = 'root'
): EventInteractiveTerminalUpdated {
  return {
    id: 'event',
    type: 'interactive_terminal.updated',
    properties: {
      info: {
        id: 'terminal-not-a-session',
        sessionID,
        pid: 123,
        command: 'git commit',
        cwd: directory,
        status,
        cols: 80,
        rows: 24,
        time: { started: 1, updated: 2 },
      },
    },
  };
}

function resourceEvents(sessionID = 'root') {
  return [
    ...(['starting', 'running', 'ready', 'exited', 'failed', 'stopping', 'stopped'] as const).map(
      status => backgroundEvent(status, sessionID)
    ),
    {
      id: 'event',
      type: 'background_process.deleted',
      properties: { sessionID, processID: 'process-not-a-session', scope: 'session' },
    },
    interactiveEvent('running', sessionID),
    interactiveEvent('closed', sessionID),
    {
      id: 'event',
      type: 'interactive_terminal.data',
      properties: {
        sessionID,
        terminalID: 'terminal-not-a-session',
        data: 'output must not be forwarded',
        cursor: 10,
      },
    },
    {
      id: 'event',
      type: 'interactive_terminal.deleted',
      properties: { sessionID, terminalID: 'terminal-not-a-session' },
    },
  ] satisfies Event[];
}

function ptyEvents(sessionID?: Pty['sessionID']) {
  const info: Pty = {
    id: 'pty-not-a-session',
    title: 'Terminal',
    command: 'sh',
    args: [],
    cwd: directory,
    status: 'running',
    pid: 123,
    ...(sessionID !== undefined ? { sessionID } : {}),
  };
  return [
    { id: 'event', type: 'pty.created', properties: { info } },
    { id: 'event', type: 'pty.updated', properties: { info } },
    { id: 'event', type: 'pty.updated', properties: { info: { ...info, status: 'exited' } } },
    { id: 'event', type: 'pty.exited', properties: { id: info.id, exitCode: 1 } },
    { id: 'event', type: 'pty.deleted', properties: { id: info.id } },
  ] satisfies Event[];
}

const mutations: Event[] = [
  { id: 'event', type: 'file.edited', properties: { file: '/worktree/file.ts' } },
  ...(['add', 'change', 'unlink'] as const).map(event => ({
    id: 'event',
    type: 'file.watcher.updated' as const,
    properties: { file: '/worktree/file.ts', event },
  })),
  { id: 'event', type: 'vcs.branch.updated', properties: { branch: 'feature' } },
  { id: 'event', type: 'vcs.branch.updated', properties: {} },
  { id: 'event', type: 'session.diff', properties: { sessionID: 'root', diff: [] } },
  {
    id: 'event',
    type: 'message.part.updated',
    properties: {
      sessionID: 'root',
      time: 1,
      part: {
        id: 'part',
        sessionID: 'root',
        messageID: 'assistant',
        type: 'patch',
        hash: 'snapshot',
        files: ['file.ts'],
      },
    },
  },
  toolEvent({ status: 'running', input: {}, time: { start: 1 } }),
  toolEvent({
    status: 'completed',
    input: {},
    output: '',
    title: '',
    metadata: {},
    time: { start: 1, end: 2 },
  }),
  toolEvent({ status: 'error', input: {}, error: 'Partially wrote', time: { start: 1, end: 2 } }),
  {
    id: 'event',
    type: 'session.next.tool.called',
    properties: {
      ...nextProperties,
      tool: 'arbitrary_shell_tool',
      input: {},
      provider: { executed: false },
    },
  },
  {
    id: 'event',
    type: 'session.next.tool.progress',
    properties: { ...nextProperties, structured: {}, content: [] },
  },
  {
    id: 'event',
    type: 'session.next.tool.success',
    properties: { ...nextProperties, structured: {}, content: [], provider: { executed: false } },
  },
  {
    id: 'event',
    type: 'session.next.tool.failed',
    properties: {
      ...nextProperties,
      error: { type: 'unknown', message: 'Partially wrote' },
      provider: { executed: false },
    },
  },
  {
    id: 'event',
    type: 'session.next.shell.started',
    properties: {
      timestamp: 1,
      sessionID: 'root',
      messageID: 'message',
      callID: 'call',
      command: 'sh',
    },
  },
  {
    id: 'event',
    type: 'session.next.shell.ended',
    properties: { timestamp: 1, sessionID: 'root', callID: 'call', output: '' },
  },
];

type SendEvent = Parameters<typeof createWorktreeMutationNotifications>[0]['sendEvent'];
const disposers: Array<() => void> = [];

function setup(deliver?: SendEvent, signal?: AbortSignal) {
  const sessions: HandlerSessionSnapshot[] = [];
  const runtimes = new Map<string, WorktreeKiloRuntime>();
  const abort = new AbortController();
  const sendEvent = mock(deliver ?? (() => true));
  const notifications = createWorktreeMutationNotifications({
    sessions,
    kiloRuntimes: { get: directory => runtimes.get(directory) },
    signal: signal ?? abort.signal,
    sendEvent,
  });
  disposers.push(notifications.dispose);
  function addRuntime(directory: string) {
    const controller = new AbortController();
    let client = {} as WrapperKiloClient;
    const runtime: WorktreeKiloRuntime = {
      runtimeId: crypto.randomUUID(),
      directory,
      scopeId: directory,
      env: {},
      signal: controller.signal,
      get kiloClient() {
        return client;
      },
    };
    runtimes.set(directory, runtime);
    return {
      runtime,
      controller,
      replaceClient() {
        client = {} as WrapperKiloClient;
      },
    };
  }
  function attach(kiloSessionId: string, worktree = directory) {
    rememberAttachedRoot(kiloSessionId, worktree);
    const snapshot = { kiloSessionId, lastActivityAt: 123, pendingInputs: new Set(['question']) };
    sessions.push(snapshot);
    return snapshot;
  }
  const source = addRuntime(directory);
  const snapshot = attach('root');
  return {
    ...source,
    notifications,
    sessions,
    runtimes,
    abort,
    sendEvent,
    addRuntime,
    attach,
    snapshot,
  };
}

function expectedHint(kiloSessionId = 'root', worktree = directory): Parameters<SendEvent> {
  return [
    'session.event',
    { type: WORKTREE_CHANGED_EVENT, properties: {} },
    { directory: worktree, kiloSessionId, rootKiloSessionId: kiloSessionId },
  ];
}

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  jest.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  jest.useRealTimers();
  resetSessionDirectoryState();
  resetDirectoryOperationState();
});

describe('worktree mutation notifications', () => {
  it.each([...mutations, ...ptyEvents(), ...ptyEvents(null)])(
    'recognizes SDK $type mutation signals',
    event => {
      const h = setup();
      h.notifications.observe(h.runtime, { ...event, directory });
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
    }
  );

  it.each(resourceEvents())(
    'notifies SDK $type activity after its launch tool completes',
    event => {
      const h = setup();
      h.notifications.observe(
        h.runtime,
        toolEvent({
          status: 'completed',
          input: {},
          output: '',
          title: '',
          metadata: {},
          time: { start: 1, end: 2 },
        })
      );
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
      h.notifications.observe(h.runtime, { ...event, directory });
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint()]);
    }
  );

  it.each(['root', 'sibling', 'child'])(
    'scopes resource activity for %s without treating resource IDs as sessions',
    sessionID => {
      const h = setup();
      h.attach('sibling');
      h.addRuntime('/other');
      h.attach('other', '/other');
      rememberChildSession({ childId: 'child', parentId: 'root' });
      const before = structuredClone(h.sessions);
      for (const event of [...resourceEvents(sessionID), ...ptyEvents(sessionID)]) {
        h.notifications.observe(h.runtime, { ...event, directory });
      }
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint('sibling')]);
      expect(h.sessions).toEqual(before);
    }
  );

  it.each([undefined, null, 123, '', 'foreign'])(
    'does not turn invalid resource session ID %# into a directory hint',
    sessionID => {
      const h = setup();
      for (const event of resourceEvents()) {
        const properties = event.properties;
        const malformed =
          'info' in properties
            ? { ...properties, info: { ...properties.info, id: 'root', sessionID } }
            : { ...properties, sessionID };
        h.notifications.observe(h.runtime, { ...event, properties: malformed, directory });
        if ('info' in properties) {
          h.notifications.observe(h.runtime, {
            ...event,
            properties: { ...malformed, sessionID: 'root' },
            directory,
          });
        }
      }
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('rejects conflicting resource scope even when both IDs name attached siblings', () => {
    const h = setup();
    h.attach('sibling');
    for (const event of [...resourceEvents(), ...ptyEvents('root')]) {
      const properties = event.properties;
      for (const extra of [{ sessionId: 'sibling' }, { part: { sessionID: 'sibling' } }]) {
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { ...properties, ...extra, sessionID: 'root' },
          directory,
        });
      }
      if ('info' in properties) {
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { ...properties, sessionID: 'sibling' },
          directory,
        });
      } else {
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { ...properties, sessionID: 'root', info: { id: 'resource-not-a-session' } },
          directory,
        });
      }
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it('rejects resource sessions belonging to another emitting runtime', () => {
    const h = setup();
    const other = h.addRuntime('/other');
    h.attach('other', '/other');
    rememberChildSession({ childId: 'other-child', parentId: 'other' });
    for (const sessionID of ['other', 'other-child']) {
      for (const event of [...resourceEvents(sessionID), ...ptyEvents(sessionID)]) {
        if (event.type === 'pty.exited' || event.type === 'pty.deleted') continue;
        h.notifications.observe(h.runtime, { ...event, directory: '/other' });
        h.notifications.observe(h.runtime, { ...event, directory });
      }
    }
    for (const event of resourceEvents()) {
      h.notifications.observe(other.runtime, { ...event, directory });
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, '/other', '/worktree/', '/worktree/subdirectory'])(
    'requires an exact declared directory for sessionless PTYs %#',
    declaredDirectory => {
      const h = setup();
      h.attach('sibling');
      for (const event of [...ptyEvents(), ...ptyEvents(null)]) {
        h.notifications.observe(h.runtime, { ...event, directory: declaredDirectory });
      }
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each([false, 123, '', 'foreign'])(
    'rejects malformed or foreign optional PTY session IDs %#',
    sessionID => {
      const h = setup();
      for (const event of ptyEvents()) {
        if (!('info' in event.properties)) continue;
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { info: { ...event.properties.info, sessionID } },
          directory,
        });
      }
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent).not.toHaveBeenCalled();
    }
  );

  it('does not infer a PTY session from a resource ID or discard explicit foreign scope', () => {
    const h = setup();
    for (const event of [...ptyEvents(), ...ptyEvents(null)]) {
      if ('info' in event.properties) {
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { info: { ...event.properties.info, id: 'root' } },
        });
        expect(eventKiloSessionId(event.properties)).toBe('pty-not-a-session');
      }
      for (const scope of [
        { sessionID: 'foreign' },
        { sessionID: null },
        { sessionId: 123 },
        { part: { sessionID: 'foreign' } },
      ]) {
        h.notifications.observe(h.runtime, {
          ...event,
          properties: { ...event.properties, ...scope },
          directory,
        });
      }
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it('ignores malformed resource identity and lifecycle fields', () => {
    const h = setup();
    for (const event of [...resourceEvents(), ...ptyEvents()]) {
      const properties = event.properties;
      const invalid =
        'info' in properties
          ? [
              { ...properties, info: null },
              { ...properties, info: { ...properties.info, status: 'unknown' } },
              ...[undefined, null, 123, ''].map(id => ({
                ...properties,
                info: { ...properties.info, id },
              })),
            ]
          : [undefined, null, 123, ''].map(id => ({
              ...properties,
              [event.type === 'background_process.deleted'
                ? 'processID'
                : event.type.startsWith('pty.')
                  ? 'id'
                  : 'terminalID']: id,
            }));
      for (const properties of invalid) {
        h.notifications.observe(h.runtime, { ...event, properties, directory });
      }
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds sustained terminal output hints without forwarding output', () => {
    const h = setup();
    const event = resourceEvents().find(event => event.type === 'interactive_terminal.data');
    if (!event) throw new Error('Missing terminal data fixture');
    for (let index = 0; index < 20; index += 1) {
      h.notifications.observe(h.runtime, { ...event, directory });
      jest.advanceTimersByTime(500);
    }
    expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coalesces a mixed burst after quiet and starts a fresh burst without extra trailing hints', () => {
    const h = setup();
    for (const event of [...mutations, ...resourceEvents(), ...ptyEvents()]) {
      h.notifications.observe(h.runtime, { ...event, directory });
      jest.advanceTimersByTime(50);
    }
    jest.advanceTimersByTime(4_949);
    expect(h.sendEvent).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
    expect(jest.getTimerCount()).toBe(0);
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint()]);
    jest.advanceTimersByTime(10_000);
    expect(h.sendEvent).toHaveBeenCalledTimes(2);
  });

  it('flushes sustained changes within ten seconds and bounds timers across subsequent bursts', () => {
    const h = setup();
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    for (let elapsed = 500; elapsed <= 20_000; elapsed += 500) {
      jest.advanceTimersByTime(500);
      expect(h.sendEvent).toHaveBeenCalledTimes(Math.floor(elapsed / 10_000));
      h.notifications.observe(h.runtime, { ...fileEdited, directory });
      expect(jest.getTimerCount()).toBe(2);
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('notifies attached sibling roots for a valid grandchild mutation, not other worktrees', () => {
    const h = setup();
    h.attach('sibling');
    h.addRuntime('/other');
    h.attach('other', '/other');
    rememberChildSession({ childId: 'child', parentId: 'root' });
    rememberChildSession({ childId: 'grandchild', parentId: 'child' });
    h.notifications.observe(h.runtime, {
      type: 'session.next.tool.failed',
      properties: { ...nextProperties, sessionID: 'grandchild' },
    });
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint('sibling')]);
  });

  it('observes ambiguous sessionless feed events before routing without modifying original events or activity', async () => {
    const h = setup();
    h.attach('sibling');
    const activity = createSessionActivityRegistry();
    activity.attach('root');
    activity.attach('sibling');
    const deps = createControlHandlerDeps({
      sessions: h.sessions,
      activity,
      version: 'test',
      kiloReady: true,
      emitSessionEvent: () => {},
      retireRuntime: () => {},
    });
    const snapshots = structuredClone(h.sessions);
    const heartbeat = buildHeartbeatPayload(deps);
    const routed = [];
    const received = [];
    const envelopes = [
      ...mutations.filter(event =>
        ['file.edited', 'file.watcher.updated', 'vcs.branch.updated'].includes(event.type)
      ),
      ...ptyEvents(),
      ...ptyEvents(null),
    ].map(payload => ({ directory, payload }));
    for await (const event of unfilteredKiloEvents(envelopes)) {
      h.notifications.observe(h.runtime, event);
      received.push(event);
      const identity = sessionEventIdentity({
        ...event,
        sessionId: eventKiloSessionId(event.properties),
        runtimeDirectory: h.runtime.directory,
      });
      if (identity?.rootKiloSessionId) routed.push(event);
    }
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint('sibling')]);
    expect(received).toEqual(
      envelopes.map(({ payload, directory }) => ({
        type: payload.type,
        properties: payload.properties,
        directory,
      }))
    );
    expect(routed).toEqual([]);
    expect(h.sessions).toEqual(snapshots);
    expect(buildHeartbeatPayload(deps)).toEqual({
      ...heartbeat,
      sessions: heartbeat.sessions?.map(session => ({
        ...session,
        idleForMs: session.idleForMs + 5_000,
      })),
    });
  });

  it.each([
    { ...fileEdited },
    { ...fileEdited, directory: '/other' },
    { ...fileEdited, directory: '/worktree/' },
    { ...fileEdited, directory: '/worktree/subdirectory' },
    { type: 'vcs.branch.updated', properties: {}, directory: '/other' },
    ...[
      { sessionID: 'foreign' },
      { sessionID: '' },
      { sessionID: null },
      { sessionID: 123 },
      { sessionID: undefined },
      { sessionId: 'foreign' },
      { sessionId: false },
      { info: { id: 'foreign' } },
      { info: { sessionID: null } },
      { part: { sessionID: 'foreign' } },
      { part: { sessionID: 123 } },
      { sessionID: 'root', sessionId: 'foreign' },
      { sessionID: 'root', part: { sessionID: 'foreign' } },
      { sessionID: 'root', info: { id: 'foreign' } },
    ].map(scope => ({
      ...fileEdited,
      directory,
      properties: { ...fileEdited.properties, ...scope },
    })),
    { type: 'session.diff', directory, properties: { diff: [] } },
    { type: 'session.diff', directory, properties: { sessionID: 'foreign', diff: [] } },
    { type: 'session.next.tool.called', directory, properties: { callID: 'call' } },
    {
      type: 'message.part.updated',
      directory,
      properties: {
        sessionID: 'root',
        part: { type: 'patch', sessionID: 'foreign', files: [], hash: '' },
      },
    },
  ])('rejects missing, foreign, conflicting, or malformed scope %#', event => {
    const h = setup();
    h.notifications.observe(h.runtime, event);
    jest.advanceTimersByTime(10_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects foreign emitting runtimes and children outside the exact worktree', () => {
    const h = setup();
    const other = h.addRuntime('/other');
    h.attach('other', '/other');
    rememberChildSession({ childId: 'external-child', parentId: 'root', directory: '/external' });
    rememberChildSession({ childId: 'other-child', parentId: 'other' });
    for (const [runtime, sessionID, eventDirectory] of [
      [other.runtime, 'root', directory],
      [h.runtime, 'other', '/other'],
      [h.runtime, 'other-child', '/other'],
      [h.runtime, 'external-child', '/external'],
    ] as const) {
      h.notifications.observe(runtime, {
        type: 'session.diff',
        directory: eventDirectory,
        properties: { sessionID, diff: [] },
      });
    }
    jest.advanceTimersByTime(10_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    'server.heartbeat',
    'message.part.delta',
    'session.next.text.delta',
    'session.next.reasoning.delta',
    'session.next.tool.input.started',
    'session.next.tool.input.delta',
    'session.next.tool.input.ended',
    'session.status',
    'message.updated',
    WORKTREE_CHANGED_EVENT,
  ])('ignores nonmutating %s events', type => {
    const h = setup();
    h.notifications.observe(h.runtime, { type, properties: nextProperties, directory });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    toolEvent({ status: 'pending', input: {}, raw: '{}' }),
    {
      type: 'message.part.updated',
      properties: { sessionID: 'root', part: { type: 'text', sessionID: 'root', text: 'hello' } },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: 'root',
        part: { type: 'reasoning', sessionID: 'root', text: 'thinking' },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: 'root',
        part: { type: 'tool', sessionID: 'root', tool: 'shell', state: { status: ['running'] } },
      },
    },
    { type: 'file.edited', properties: { file: 1 } },
    { type: 'file.watcher.updated', properties: { file: 'file', event: 'read' } },
    { type: 'file.watcher.updated', properties: { file: 'file', event: ['change'] } },
    { type: 'vcs.branch.updated', properties: { branch: null } },
  ])('ignores nonmutating or malformed mutation payload %#', event => {
    const h = setup();
    h.notifications.observe(h.runtime, { ...event, directory });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    'detach',
    'reattach',
    'move',
    'move-back',
    'snapshot-replacement',
    'snapshot-removal',
    'snapshot-id-change',
  ])('drops stale targets after %s', change => {
    const h = setup();
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    if (change === 'detach' || change === 'reattach') forgetAttachedRoot('root');
    if (change === 'reattach') rememberAttachedRoot('root', directory);
    if (change === 'move' || change === 'move-back') rememberAttachedRoot('root', '/other');
    if (change === 'move-back') rememberAttachedRoot('root', directory);
    if (change === 'snapshot-replacement') h.sessions.splice(0, 1, { ...h.snapshot });
    if (change === 'snapshot-removal') h.sessions.splice(0, 1);
    if (change === 'snapshot-id-change') h.snapshot.kiloSessionId = 'replacement';
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps pending hints across idempotent attachment and ignores late nonmutating traffic', () => {
    const h = setup();
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(4_900);
    rememberAttachedRoot('root', directory);
    h.notifications.observe(h.runtime, {
      type: 'session.next.tool.input.delta',
      properties: { ...nextProperties, delta: 'input' },
      directory,
    });
    jest.advanceTimersByTime(100);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('debounces independent worktrees separately', () => {
    const h = setup();
    const other = h.addRuntime('/other');
    h.attach('other', '/other');
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(500);
    h.notifications.observe(other.runtime, { ...fileEdited, directory: '/other' });
    jest.advanceTimersByTime(4_500);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
    jest.advanceTimersByTime(500);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint(), expectedHint('other', '/other')]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not notify a newly attached root or replacement from an older shared-worktree event', () => {
    const h = setup();
    h.attach('sibling');
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    forgetAttachedRoot('root');
    h.sessions.splice(0, 1);
    h.attach('root');
    h.attach('new');
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint('sibling')]);
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls.slice(1)).toEqual([
      expectedHint('sibling'),
      expectedHint(),
      expectedHint('new'),
    ]);
  });

  it.each([
    'retirement',
    'replacement',
    'missing-runtime',
    'client-replacement',
    'abort',
    'dispose',
    'deletion',
  ])('drops queued hints after runtime %s', async change => {
    const h = setup();
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    if (change === 'retirement') h.controller.abort();
    if (change === 'replacement') h.addRuntime(directory);
    if (change === 'missing-runtime') h.runtimes.clear();
    if (change === 'client-replacement') h.replaceClient();
    if (change === 'abort') h.abort.abort();
    if (change === 'dispose') h.notifications.dispose();
    if (change === 'deletion') await fenceDirectoryOperations(directory);
    if (['retirement', 'abort', 'dispose'].includes(change)) expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10_000);
    expect(h.sendEvent).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects retired runtime callbacks after replacement and allows new runtime mutations', () => {
    const h = setup();
    const replacement = h.addRuntime(directory);
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    expect(jest.getTimerCount()).toBe(0);
    h.notifications.observe(replacement.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent.mock.calls).toEqual([expectedHint()]);
  });

  it('never queues while aborted, disposed, deleting, or without an attached snapshot', async () => {
    const h = setup(undefined, AbortSignal.abort());
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    const live = setup();
    live.sessions.splice(0);
    live.notifications.observe(live.runtime, { ...fileEdited, directory });
    live.attach('root');
    await fenceDirectoryOperations(directory);
    live.notifications.observe(live.runtime, { ...fileEdited, directory });
    live.notifications.dispose();
    live.notifications.observe(live.runtime, { ...fileEdited, directory });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'reject', 'false'])(
    'contains %s delivery failures without blocking sibling roots or subsequent bursts',
    async failure => {
      let attempts = 0;
      const h = setup(() => {
        attempts += 1;
        if (attempts === 1) {
          if (failure === 'throw') throw new Error('delivery failed');
          if (failure === 'reject') return Promise.reject(new Error('delivery failed'));
          return false;
        }
        return true;
      });
      h.attach('sibling');
      h.notifications.observe(h.runtime, { ...fileEdited, directory });
      expect(() => jest.advanceTimersByTime(5_000)).not.toThrow();
      await Promise.resolve();
      h.notifications.observe(h.runtime, { ...fileEdited, directory });
      jest.advanceTimersByTime(5_000);
      expect(h.sendEvent).toHaveBeenCalledTimes(4);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('stops the flush when delivery triggers socket-disconnect shutdown', () => {
    const h = setup(() => h.abort.abort());
    h.attach('sibling');
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    jest.advanceTimersByTime(5_000);
    expect(h.sendEvent).toHaveBeenCalledTimes(1);
    h.notifications.observe(h.runtime, { ...fileEdited, directory });
    expect(jest.getTimerCount()).toBe(0);
  });
});
