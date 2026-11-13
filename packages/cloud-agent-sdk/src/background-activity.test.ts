import {
  createBackgroundActivityReader,
  selectBackgroundActivity,
  backgroundActivityLabel,
  backgroundActivitySummary,
  serializeBackgroundActivityReads,
  type BackgroundActivityState,
} from './background-activity';
import type { BackgroundActivityInventory } from '@kilocode/session-ingest-contracts';
import { cloudAgentId } from './test-helpers';

const inventory: BackgroundActivityInventory = {
  sessionID: 'ses_root',
  sessions: [
    { id: 'ses_root' },
    { id: 'ses_child', parentID: 'ses_root', title: 'Explore' },
    { id: 'ses_grandchild', parentID: 'ses_child' },
    { id: 'ses_sibling' },
  ],
  jobs: [
    {
      id: 'job_agent',
      kind: 'subagent',
      sessionID: 'ses_root',
      childSessionID: 'ses_child',
      agent: 'explore',
      description: 'Inspect commands',
      status: 'running',
      time: { started: 1 },
    },
    {
      id: 'job_shell',
      kind: 'shell',
      sessionID: 'ses_child',
      shellID: 'sh_child',
      command: 'sleep 10',
      status: 'running',
      time: { started: 1 },
    },
    {
      id: 'job_done',
      kind: 'shell',
      sessionID: 'ses_root',
      shellID: 'sh_done',
      command: 'true',
      status: 'completed',
      time: { started: 1, completed: 2 },
    },
    {
      id: 'job_sibling',
      kind: 'shell',
      sessionID: 'ses_sibling',
      shellID: 'sh_sibling',
      command: 'sleep 10',
      status: 'running',
      time: { started: 1 },
    },
  ],
  waits: [],
};

test('counts only running root and descendant jobs, deduplicated by native identity', () => {
  const items = selectBackgroundActivity({
    ...inventory,
    jobs: [...inventory.jobs, inventory.jobs[0]!],
  });
  expect(items.map(item => item.id)).toEqual(['job_agent', 'job_shell']);
  expect(items[1]).toMatchObject({ descendant: true, parentLabel: 'Explore' });
  expect(backgroundActivityLabel({ status: 'current', inventory })).toBe(
    'Background · 1 agent running · 1 shell running'
  );
  expect(backgroundActivitySummary({ status: 'current', inventory })).toBe('1 agent · 1 shell');
});

test.each(['question', 'permission'] as const)('%s waits are separate from runnable work', kind => {
  const value = { ...inventory, waits: [{ sessionID: 'ses_grandchild', kind }] };
  expect(selectBackgroundActivity(value)[0]?.waiting).toBe(true);
  expect(backgroundActivityLabel({ status: 'current', inventory: value })).toBe(
    'Background · 1 shell running · 1 needs input'
  );
  expect(backgroundActivitySummary({ status: 'current', inventory: value })).toBe(
    '1 shell · 1 needs input'
  );
});

test('the compact summary pluralizes counts and names unknown status', () => {
  const shell = inventory.jobs[1]!;
  const value = {
    ...inventory,
    jobs: [
      ...inventory.jobs,
      { ...shell, id: 'job_shell_2', shellID: 'sh_child_2' },
      { ...inventory.jobs[0]!, id: 'job_agent_2', childSessionID: 'ses_grandchild' },
    ],
  };
  expect(backgroundActivitySummary({ status: 'current', inventory: value })).toBe(
    '2 agents · 2 shells'
  );
  expect(backgroundActivitySummary({ status: 'loading' })).toBe('Checking status');
  expect(backgroundActivitySummary({ status: 'unavailable' })).toBe('Status unavailable');
});

test('switching back waits for the old request, then makes a fresh read instead of reusing its inventory', async () => {
  let finish!: (value: unknown) => void;
  const read = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    )
    .mockResolvedValue({ ...inventory, jobs: [] });
  const source = serializeBackgroundActivityReads(read);
  const sessionId = cloudAgentId('workspace_11111111-1111-4111-8111-111111111111');
  const old = new AbortController();
  const first = source({ sessionId, signal: old.signal }).catch(() => 'aborted');
  old.abort();
  const second = source({ sessionId, signal: new AbortController().signal });
  expect(read).toHaveBeenCalledTimes(1);
  finish(inventory);
  expect(await first).toBe('aborted');
  expect(await second).toEqual({ ...inventory, jobs: [] });
  expect(read).toHaveBeenCalledTimes(2);
});

describe('authoritative reader', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const advance = () => jest.advanceTimersByTimeAsync(100);

  test('coalesces lifecycle bursts and publishes an overtaken read before reading again', async () => {
    let resolve!: (value: unknown) => void;
    const read = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(r => {
            resolve = r;
          })
      )
      .mockResolvedValue({ ...inventory, jobs: [] });
    const states: BackgroundActivityState[] = [];
    const reader = createBackgroundActivityReader({
      sessionID: 'ses_root',
      read,
      publish: state => states.push(state),
    });
    reader.start();
    await advance();
    for (let i = 0; i < 10; i++) reader.invalidate();
    await jest.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve(inventory);
    await advance();
    expect(states.filter(state => state.status === 'current')).toEqual([
      { status: 'current', inventory },
    ]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(states.filter(state => state.status === 'current')).toEqual([
      { status: 'current', inventory },
      { status: 'current', inventory: { ...inventory, jobs: [] } },
    ]);
    expect(states.filter(state => state.status === 'loading')).toHaveLength(1);
    reader.stop();
  });

  test('streaming invalidations do not starve a current publication', async () => {
    const read = jest.fn().mockResolvedValue(inventory);
    const states: BackgroundActivityState[] = [];
    const reader = createBackgroundActivityReader({
      sessionID: 'ses_root',
      read,
      publish: state => states.push(state),
    });
    reader.start();
    for (let i = 0; i < 50; i++) {
      reader.invalidate();
      await jest.advanceTimersByTimeAsync(50);
    }
    expect(states.filter(state => state.status === 'current').length).toBeGreaterThan(0);
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    reader.stop();
  });

  test('stop hides the strip, and retry while stopped does nothing', async () => {
    const read = jest.fn().mockResolvedValue(inventory);
    const publish = jest.fn();
    const reader = createBackgroundActivityReader({ sessionID: 'ses_root', read, publish });
    reader.start();
    await advance();
    reader.stop();
    expect(publish).toHaveBeenLastCalledWith({ status: 'inactive' });
    reader.retry();
    await advance();
    expect(publish).toHaveBeenLastCalledWith({ status: 'inactive' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('disconnect aborts the in-flight read and reconnect does not wait for it', async () => {
    let resolve!: (value: unknown) => void;
    const read = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(r => {
            resolve = r;
          })
      )
      .mockResolvedValue({ ...inventory, jobs: [] });
    const states: BackgroundActivityState[] = [];
    const reader = createBackgroundActivityReader({
      sessionID: 'ses_root',
      read,
      publish: state => states.push(state),
    });
    reader.start();
    await advance();
    const firstSignal = read.mock.calls[0]![0] as AbortSignal;
    reader.stop();
    expect(firstSignal.aborted).toBe(true);
    reader.start();
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    resolve(inventory);
    await advance();
    expect(states.filter(state => state.status === 'current')).toEqual([
      { status: 'current', inventory: { ...inventory, jobs: [] } },
    ]);
    reader.stop();
  });

  test('failed reads report unavailable, retry within a bound, and support an explicit retry', async () => {
    const read = jest.fn().mockRejectedValue(new Error('offline'));
    const publish = jest.fn();
    const reader = createBackgroundActivityReader({ sessionID: 'ses_root', read, publish });
    reader.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' });
    read.mockResolvedValue(inventory);
    reader.retry();
    await advance();
    expect(publish).toHaveBeenLastCalledWith({ status: 'current', inventory });
    reader.stop();
  });

  test('a different chat response cannot restore liveness', async () => {
    const publish = jest.fn();
    const reader = createBackgroundActivityReader({
      sessionID: 'ses_other',
      read: async () => inventory,
      publish,
    });
    reader.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenLastCalledWith({ status: 'unavailable' });
    expect(publish.mock.calls.some(([state]) => state.status === 'current')).toBe(false);
    reader.stop();
  });
});
