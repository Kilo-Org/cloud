import { describe, expect, it } from 'bun:test';
import {
  createSessionSupervisor,
  type ExecutionFailure,
  type ExecutionIdentity,
  type SessionObservation,
} from './session-supervisor.js';

const MINUTE = 60_000;

function fixture() {
  let now = 1_000;
  const failures: Array<{ identity: ExecutionIdentity; reason: ExecutionFailure }> = [];
  const interruptions: Array<{
    identity: ExecutionIdentity;
    reason: ExecutionFailure;
    signal: AbortSignal;
    done: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  const recovery: string[] = [];
  const supervisor = createSessionSupervisor({
    nativeRuntimeId: 'runtime-1',
    directory: '/workspace',
    timers: { noProgressMs: 20 * MINUTE, turnHardCapMs: 120 * MINUTE },
    now: () => now,
    onDeadline: (identity, reason) => failures.push({ identity, reason }),
    interrupt: (identity, reason, signal) => {
      const done = Promise.withResolvers<void>();
      interruptions.push({ identity, reason, signal, done });
      return done.promise;
    },
    onObservationFailure: reason => recovery.push(reason),
  });
  function event(type: string, properties: Record<string, unknown>, runtime = 'runtime-1') {
    supervisor.observe({ type, properties, nativeRuntimeId: runtime, directory: '/workspace' });
  }
  function open(id = 'root', parentID?: string) {
    event('session.created', { info: { id, parentID, directory: '/workspace' } });
    event('session.turn.open', { sessionID: id });
    event('session.status', { sessionID: id, status: { type: 'busy' } });
    event('message.updated', { info: { id: `assistant-${id}`, sessionID: id, role: 'assistant' } });
  }
  function tool(
    id = 'root',
    partID = 'tool',
    status = 'running',
    name = 'bash',
    metadata: Record<string, unknown> = {}
  ) {
    event('message.part.updated', {
      part: {
        id: partID,
        sessionID: id,
        messageID: `assistant-${id}`,
        type: 'tool',
        tool: name,
        callID: partID,
        state: { status, metadata },
      },
    });
  }
  function text(id = 'root', content = 'output') {
    event('message.part.updated', {
      part: {
        id: 'text',
        sessionID: id,
        messageID: `assistant-${id}`,
        type: 'text',
        text: content,
      },
    });
  }
  function close(id = 'root') {
    event('session.status', { sessionID: id, status: { type: 'idle' } });
    event('session.turn.close', { sessionID: id, reason: 'completed' });
  }
  return {
    supervisor,
    event,
    open,
    tool,
    text,
    close,
    failures,
    interruptions,
    recovery,
    advance(ms: number) {
      now += ms;
    },
    async confirmed() {
      interruptions.at(-1)?.done.resolve();
      await Promise.resolve();
    },
  };
}

function observation(
  id = 'root',
  status: SessionObservation['status'] = 'busy'
): SessionObservation {
  return { id, directory: '/workspace', status, messages: [], interactions: [] };
}

describe('native session supervision', () => {
  for (const runningTool of [false, true]) {
    it(`interrupts at 20 minutes with runningTool=${runningTool}, never a tick early`, async () => {
      const f = fixture();
      f.open();
      if (runningTool) f.tool();
      f.advance(20 * MINUTE - 1);
      f.supervisor.tick();
      expect(f.interruptions).toHaveLength(0);
      f.advance(1);
      f.supervisor.tick();
      expect(f.failures.map(failure => failure.reason)).toEqual(['no_progress']);
      expect(f.interruptions[0].identity.sessionId).toBe('root');
      expect(f.supervisor.needsCompute()).toBe(true);
      expect(f.supervisor.state('root')?.activity).toBe('stopping');
      f.supervisor.tick();
      expect(f.interruptions).toHaveLength(1);
      await f.confirmed();
      expect(f.supervisor.needsCompute()).toBe(false);
      expect(f.supervisor.observedSessions()).toEqual([]);
    });
  }

  it('gives real tool output just before expiry a fresh window, but ignores unchanged tools and metadata', () => {
    const f = fixture();
    f.open();
    f.tool();
    f.advance(20 * MINUTE - 1);
    f.tool('root', 'tool', 'running', 'bash', { output: 'actual output' });
    f.advance(20 * MINUTE - 1);
    f.tool('root', 'tool', 'running', 'bash', {
      output: 'actual output',
      title: 'metadata changed',
    });
    f.supervisor.tick();
    expect(f.interruptions).toHaveLength(0);
    f.advance(1);
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('does not mistake user text, repeated busy/retry, or heartbeat for progress', () => {
    const f = fixture();
    f.open();
    f.advance(19 * MINUTE);
    f.event('message.updated', { info: { id: 'native-user', sessionID: 'root', role: 'user' } });
    f.event('message.part.updated', {
      part: {
        id: 'user-text',
        messageID: 'native-user',
        sessionID: 'root',
        type: 'text',
        text: 'native input',
      },
    });
    f.event('message.part.delta', {
      sessionID: 'root',
      messageID: 'native-user',
      delta: 'more input',
    });
    f.event('session.status', { sessionID: 'root', status: { type: 'retry' } });
    f.event('session.status', { sessionID: 'root', status: { type: 'busy' } });
    f.event('server.heartbeat', {});
    expect(f.supervisor.state('root')?.progressed).toBe(false);
    f.advance(MINUTE);
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('pauses only inactivity while all tools wait, retaining each request independently', () => {
    const f = fixture();
    f.open();
    f.advance(10 * MINUTE);
    f.event('question.asked', { sessionID: 'root', id: 'q1' });
    f.event('permission.asked', { sessionID: 'root', id: 'p2' });
    expect(f.supervisor.needsCompute()).toBe(false);
    f.advance(30 * MINUTE);
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
    f.event('question.replied', { sessionID: 'root', requestID: 'q1' });
    expect(f.supervisor.needsCompute()).toBe(false);
    f.event('permission.replied', { sessionID: 'root', requestID: 'p2' });
    expect(f.supervisor.needsCompute()).toBe(true);
    f.advance(10 * MINUTE - 1);
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
    f.advance(1);
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('keeps independent tools runnable while blocking questions wait, but not nonblocking ones', () => {
    const f = fixture();
    f.open();
    f.tool('root', 'question', 'running', 'question');
    f.event('question.asked', { sessionID: 'root', id: 'q1', tool: { callID: 'question' } });
    expect(f.supervisor.needsCompute()).toBe(false);
    f.tool('root', 'bash');
    f.event('session.status', { sessionID: 'root', status: { type: 'idle' } });
    expect(f.supervisor.needsCompute()).toBe(true);
    f.tool('root', 'bash', 'completed');
    expect(f.supervisor.needsCompute()).toBe(false);

    const nonblocking = fixture();
    nonblocking.open();
    nonblocking.event('question.asked', { sessionID: 'root', id: 'async', blocking: false });
    expect(nonblocking.supervisor.needsCompute()).toBe(true);
    nonblocking.advance(20 * MINUTE);
    nonblocking.supervisor.tick();
    expect(nonblocking.failures[0].reason).toBe('no_progress');
  });

  it('a parent task waiting on a blocked child permits sleep until independent work resumes', () => {
    const f = fixture();
    f.open();
    f.open('child', 'root');
    f.tool('root', 'task', 'running', 'task', { sessionId: 'child' });
    f.tool('child', 'question', 'running', 'question');
    f.event('question.asked', { sessionID: 'child', id: 'q1', tool: { callID: 'question' } });
    expect(f.supervisor.state('root')?.activity).toBe('waiting');
    expect(f.supervisor.needsCompute()).toBe(false);
    f.tool('root', 'independent');
    expect(f.supervisor.state('root')?.activity).toBe('running');
    expect(f.supervisor.state('child')?.activity).toBe('waiting');
  });

  it('propagates descendant progress only to ancestors and retains children after their parent ends', () => {
    const f = fixture();
    f.open();
    f.open('child', 'root');
    f.open('unrelated');
    f.advance(19 * MINUTE);
    f.text('child');
    f.advance(MINUTE);
    f.supervisor.tick();
    expect(f.failures.map(x => x.identity.sessionId)).toEqual(['unrelated']);
    f.close('root');
    expect(f.supervisor.state('root')).toBeUndefined();
    expect(f.supervisor.state('child')?.activity).toBe('running');
    f.advance(19 * MINUTE);
    f.supervisor.tick();
    expect(f.failures.map(x => x.identity.sessionId)).toEqual(['unrelated', 'child']);
  });

  it('keeps the 120 minute wall clock cap during progress and user waits', () => {
    const f = fixture();
    f.open();
    for (let step = 0; step < 11; step++) {
      f.advance(10 * MINUTE);
      f.text('root', String(step));
      f.supervisor.tick();
    }
    f.event('question.asked', { sessionID: 'root', id: 'q1' });
    f.advance(10 * MINUTE - 1);
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
    f.advance(1);
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('execution_limit');
  });

  it('one overlapping close does not reset clocks; a genuinely later execution receives new clocks', () => {
    const f = fixture();
    f.open();
    const first = f.supervisor.state('root');
    f.event('session.turn.open', { sessionID: 'root' });
    f.advance(19 * MINUTE);
    f.event('session.turn.close', { sessionID: 'root', reason: 'completed' });
    expect(f.supervisor.state('root')?.startedAt).toBe(first?.startedAt);
    f.close();
    expect(f.supervisor.state('root')).toBeUndefined();
    f.open();
    expect(f.supervisor.state('root')?.execution).not.toBe(first?.execution);
    f.advance(MINUTE);
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
  });

  it('never resets clocks for repeated snapshots and rejects snapshots staled by native progress', () => {
    const repeated = fixture();
    repeated.open();
    for (let step = 0; step < 20; step++) {
      repeated.advance(MINUTE);
      repeated.supervisor.reconcile([observation()], repeated.supervisor.beginSnapshot());
    }
    repeated.supervisor.tick();
    expect(repeated.failures[0].reason).toBe('no_progress');

    const idle = fixture();
    idle.open();
    idle.supervisor.reconcile([observation('root', 'idle')], idle.supervisor.beginSnapshot());
    expect(idle.supervisor.needsCompute()).toBe(false);

    const stale = fixture();
    stale.open();
    const token = stale.supervisor.beginSnapshot();
    stale.text();
    stale.supervisor.reconcile([observation('root', 'idle')], token);
    expect(stale.supervisor.needsCompute()).toBe(true);
    const next = stale.supervisor.beginSnapshot();
    stale.close();
    stale.supervisor.reconcile([observation()], next);
    expect(stale.supervisor.needsCompute()).toBe(false);
  });

  it('descendant progress fences an older parent snapshot', () => {
    const f = fixture();
    f.open();
    f.open('child', 'root');
    const token = f.supervisor.beginSnapshot();
    f.text('child');
    f.supervisor.reconcile([observation('root', 'idle')], token);
    expect(f.supervisor.state('root')?.activity).toBe('running');
  });

  it('applies a snapshot-only session although another session emitted events during the read', () => {
    const f = fixture();
    f.open('other');
    const token = f.supervisor.beginSnapshot();
    f.text('other');
    f.supervisor.reconcile([observation('unrouted')], token);
    expect(f.supervisor.state('unrouted')?.activity).toBe('running');
  });

  it('a busy snapshot read before cancellation was confirmed cannot resurrect the execution', async () => {
    const f = fixture();
    f.open();
    f.advance(20 * MINUTE);
    f.supervisor.tick();
    const token = f.supervisor.beginSnapshot();
    await f.confirmed();
    f.supervisor.reconcile([observation()], token);
    expect(f.supervisor.state('root')).toBeUndefined();
    expect(f.supervisor.needsCompute()).toBe(false);
  });

  it('asks snapshots to re-read only in-flight assistant messages and bounds snapshot roles', () => {
    const f = fixture();
    f.open();
    f.event('message.updated', {
      info: {
        id: 'done',
        sessionID: 'root',
        role: 'assistant',
        time: { created: 1, completed: 2 },
      },
    });
    const completed = (id: string) => ({
      info: { id, role: 'assistant', time: { created: 1, completed: 2 } },
      parts: [{ id: `${id}-text`, messageID: id, type: 'text', text: 'old' }],
    });
    f.supervisor.reconcile(
      [{ ...observation(), messages: [completed('history')] }],
      f.supervisor.beginSnapshot()
    );
    expect(f.supervisor.observedSessions()).toEqual([
      { id: 'root', directory: '/workspace', messageIds: ['assistant-root'] },
    ]);
    expect(f.recovery).toEqual([]);
    f.supervisor.reconcile(
      [
        {
          ...observation(),
          messages: Array.from({ length: 1_000 }, (_, index) => completed(`m${index}`)),
        },
      ],
      f.supervisor.beginSnapshot()
    );
    expect(f.recovery).toEqual(['activity_capacity']);
  });

  it('new progress recovered after a feed gap counts once; old or empty text never resets the deadline', () => {
    const f = fixture();
    f.open();
    f.advance(19 * MINUTE);
    f.text('root', '');
    f.supervisor.observationLost();
    const snapshot = {
      ...observation(),
      messages: [
        {
          info: { id: 'recovered', role: 'assistant', time: { created: 10_000 } },
          parts: [
            { id: 'recovered-text', messageID: 'recovered', type: 'text', text: 'new output' },
          ],
        },
      ],
    };
    f.supervisor.reconcile([snapshot], f.supervisor.beginSnapshot());
    f.advance(20 * MINUTE - 1);
    f.supervisor.reconcile([snapshot], f.supervisor.beginSnapshot());
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
    f.advance(1);
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('one tree cancellation covers expiring descendants and leaves unrelated work intact', async () => {
    const f = fixture();
    f.open('child', 'root');
    f.open('root');
    f.open('sibling');
    f.advance(19 * MINUTE);
    f.text('sibling');
    f.advance(MINUTE);
    f.supervisor.tick();
    expect(f.interruptions.map(item => item.identity.sessionId)).toEqual(['root']);
    await f.confirmed();
    expect(f.supervisor.state('root')).toBeUndefined();
    expect(f.supervisor.state('child')).toBeUndefined();
    expect(f.supervisor.state('sibling')?.activity).toBe('running');
  });

  it('does not turn a feed gap or a failed snapshot into no_progress', () => {
    const f = fixture();
    f.open();
    f.advance(20 * MINUTE);
    f.supervisor.observationLost();
    f.supervisor.tick();
    const token = f.supervisor.beginSnapshot();
    f.supervisor.snapshotFailed(token);
    f.supervisor.tick();
    expect(f.failures).toEqual([]);
    expect(f.supervisor.needsCompute()).toBe(true);
    f.supervisor.reconcile([observation()], f.supervisor.beginSnapshot());
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('hydrates an idle session with a running tool and does not replay its output as progress', () => {
    const f = fixture();
    const snapshot: SessionObservation = {
      ...observation('root', 'idle'),
      messages: [
        {
          info: { id: 'assistant-root', role: 'assistant' },
          parts: [
            {
              id: 'tool',
              messageID: 'assistant-root',
              type: 'tool',
              tool: 'bash',
              state: { status: 'running', metadata: { output: 'old' } },
            },
          ],
        },
      ],
    };
    f.supervisor.reconcile([snapshot], f.supervisor.beginSnapshot());
    expect(f.supervisor.needsCompute()).toBe(true);
    f.advance(20 * MINUTE);
    f.supervisor.reconcile([snapshot], f.supervisor.beginSnapshot());
    f.supervisor.tick();
    expect(f.failures[0].reason).toBe('no_progress');
  });

  it('keeps an unconfirmed cancellation active and escalates through the runtime owner once', async () => {
    const f = fixture();
    f.open();
    f.advance(20 * MINUTE);
    f.supervisor.tick();
    f.close();
    expect(f.supervisor.state('root')?.activity).toBe('stopping');
    f.interruptions[0].done.reject(new Error('request deadline'));
    await Promise.resolve();
    expect(f.recovery).toEqual(['abort_unconfirmed']);
    f.supervisor.tick();
    expect(f.interruptions).toHaveLength(1);
    expect(f.supervisor.needsCompute()).toBe(true);
  });

  it('late abort results cannot settle an execution started after native cancellation', async () => {
    const f = fixture();
    f.open();
    f.advance(20 * MINUTE);
    f.supervisor.tick();
    const old = f.supervisor.state('root')?.execution;
    f.close();
    f.open();
    expect(f.supervisor.state('root')?.execution).not.toBe(old);
    await f.confirmed();
    expect(f.supervisor.needsCompute()).toBe(true);
  });

  it('ignores other process identities and releases all state and in-flight requests on disposal', () => {
    const f = fixture();
    f.event('session.turn.open', { sessionID: 'other' }, 'retired-process');
    expect(f.supervisor.needsCompute()).toBe(false);
    f.open();
    f.advance(20 * MINUTE);
    f.supervisor.tick();
    const token = f.supervisor.beginSnapshot();
    f.supervisor.dispose();
    expect(f.interruptions[0].signal.aborted).toBe(true);
    f.supervisor.reconcile([observation()], token);
    f.open();
    expect(f.supervisor.needsCompute()).toBe(false);
    expect(f.supervisor.observedSessions()).toEqual([]);
  });
});
