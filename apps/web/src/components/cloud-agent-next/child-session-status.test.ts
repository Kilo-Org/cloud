import type { SessionStatus } from '@kilocode/cloud-agent-sdk/schemas';
import { getChildSessionTaskStatus, isBackgroundChildTask } from './child-session-status';
import type { StoredMessage, ToolPart } from './types';

const task: ToolPart = {
  id: 'task',
  sessionID: 'parent',
  messageID: 'parent-message',
  type: 'tool',
  callID: 'delegate',
  tool: 'task',
  state: {
    status: 'completed',
    input: { background: true },
    output: 'Started',
    title: 'Review',
    metadata: { status: 'running' },
    time: { start: 1, end: 2 },
  },
};
const child: StoredMessage = {
  info: {
    id: 'child-message',
    sessionID: 'child',
    role: 'assistant',
    parentID: 'prompt',
    time: { created: 3, completed: 4 },
    finish: 'stop',
    agent: 'explore',
    mode: 'explore',
    modelID: 'synthetic',
    providerID: 'synthetic',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
};

describe('isBackgroundChildTask', () => {
  it.each([
    [{}, false],
    [{ metadata: {} }, false],
    [{ input: {} }, false],
    [{ metadata: null, input: null }, false],
    [{ metadata: 'running', input: true }, false],
    [{ metadata: [], input: [] }, false],
    [{ metadata: { status: 'running' } }, true],
    [{ input: { background: true } }, true],
    [{ metadata: null, input: { background: true } }, true],
    [{ metadata: { status: 'running' }, input: null }, true],
  ] as const)('reads incomplete completed tool fields safely: %j', (fields, background) => {
    const incompleteTask = { ...task, state: { status: 'completed', ...fields } } as ToolPart;
    expect(isBackgroundChildTask(incompleteTask)).toBe(background);
    expect(getChildSessionTaskStatus({ taskToolPart: incompleteTask, childMessages: [] })).toBe(
      background ? 'running' : 'completed'
    );
  });
});

describe('getChildSessionTaskStatus', () => {
  it('does not treat background dispatch as child completion before messages arrive', () => {
    expect(getChildSessionTaskStatus({ taskToolPart: task, childMessages: [] })).toBe('running');
  });

  it('does not claim a child is working or failed when its history cannot load', () => {
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [],
        hydrationState: { status: 'error', message: 'Synthetic history failure' },
      })
    ).toBe('unavailable');
  });

  it.each([
    [{ type: 'busy' }, 'running'],
    [{ type: 'retry', attempt: 1, message: 'Retrying', next: 10 }, 'running'],
    [{ type: 'question' }, 'running'],
    [{ type: 'permission' }, 'running'],
    [{ type: 'idle' }, 'completed'],
    [{ type: 'scheduled' }, 'completed'],
  ] satisfies [SessionStatus, string][])(
    'uses live status %j despite a history failure',
    (sessionStatus, expected) => {
      expect(
        getChildSessionTaskStatus({
          taskToolPart: task,
          childMessages: [],
          sessionStatus,
          hydrationState: { status: 'error', message: 'Synthetic history failure' },
        })
      ).toBe(expected);
    }
  );

  it('uses available child messages or execution errors despite a history failure', () => {
    const hydrationState = { status: 'error', message: 'Synthetic history failure' } as const;
    expect(
      getChildSessionTaskStatus({ taskToolPart: task, childMessages: [child], hydrationState })
    ).toBe('completed');
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [{ ...child, info: { ...child.info, time: { created: 3 } } }],
        hydrationState,
      })
    ).toBe('running');
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [],
        childError: 'Synthetic child failure',
        hydrationState,
      })
    ).toBe('error');
  });

  it.each([
    { type: 'busy' },
    { type: 'retry', attempt: 1, message: 'Retrying', next: 10 },
    { type: 'question' },
    { type: 'permission' },
  ] satisfies SessionStatus[])(
    'keeps a child with status $type active between assistant messages',
    sessionStatus => {
      expect(
        getChildSessionTaskStatus({ taskToolPart: task, childMessages: [child], sessionStatus })
      ).toBe('running');
    }
  );

  it('completes an idle child despite stale dispatch metadata', () => {
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [child],
        sessionStatus: { type: 'idle' },
      })
    ).toBe('completed');
  });

  it('uses the current child transcript when no live status exists', () => {
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [{ ...child, info: { ...child.info, time: { created: 3 } } }],
      })
    ).toBe('running');
    expect(getChildSessionTaskStatus({ taskToolPart: task, childMessages: [child] })).toBe(
      'completed'
    );
  });

  it('does not complete a child between a tool round and its next model request', () => {
    const toolRound = { ...child, info: { ...child.info, finish: 'tool-calls' } };
    expect(getChildSessionTaskStatus({ taskToolPart: task, childMessages: [toolRound] })).toBe(
      'running'
    );
  });

  it('does not mistake an unrecognized status for completion', () => {
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [],
        sessionStatus: { type: 'future-status' },
      })
    ).toBe('running');
  });

  it('shows a child failure instead of successful dispatch', () => {
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [child],
        childError: 'Synthetic child failure',
      })
    ).toBe('error');
    const failed = {
      ...child,
      info: {
        ...child.info,
        error: { name: 'UnknownError' as const, data: { message: 'Synthetic failure' } },
      },
    };
    expect(
      getChildSessionTaskStatus({
        taskToolPart: task,
        childMessages: [failed],
        sessionStatus: { type: 'idle' },
      })
    ).toBe('error');
  });

  it.each(['pending', 'running', 'completed', 'error'] as const)(
    'preserves synchronous task status %s without child state',
    status => {
      const synchronousTask = {
        ...task,
        state: {
          ...task.state,
          status,
          input: {},
          metadata: {},
          raw: '',
          error: 'Synthetic failure',
        },
      } as ToolPart;
      expect(getChildSessionTaskStatus({ taskToolPart: synchronousTask, childMessages: [] })).toBe(
        status
      );
    }
  );
});
