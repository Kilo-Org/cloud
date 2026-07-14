import { describe, expect, it } from 'bun:test';
import type { IngestEvent } from '../../src/shared/protocol.js';
import { createRunningBashEventCoalescer } from './running-bash-event-coalescer.js';

type ScheduledTask = { id: number; callback: () => void; cancelled: boolean };

function createScheduler() {
  const tasks: ScheduledTask[] = [];
  let nextId = 1;
  return {
    schedule(callback: () => void) {
      const task = { id: nextId++, callback, cancelled: false };
      tasks.push(task);
      return task.id;
    },
    cancel(id: number) {
      const task = tasks.find(candidate => candidate.id === id);
      if (task) task.cancelled = true;
    },
    runNext() {
      const task = tasks.shift();
      if (task && !task.cancelled) task.callback();
    },
  };
}

function bashEvent(
  partId: string,
  status: string,
  output: string,
  sessionID = 'session-1',
  messageID = 'message-1'
): IngestEvent {
  const part = {
    id: partId,
    sessionID,
    messageID,
    type: 'tool',
    tool: 'bash',
    state: { status, metadata: { output } },
  };
  return {
    streamEventType: 'kilocode',
    timestamp: output,
    data: { event: 'message.part.updated', type: 'message.part.updated', properties: { part } },
  };
}

function partRemovedEvent(
  partID: string,
  sessionID = 'session-1',
  messageID = 'message-1'
): IngestEvent {
  return {
    streamEventType: 'kilocode',
    timestamp: 'removed',
    data: {
      event: 'message.part.removed',
      type: 'message.part.removed',
      properties: { sessionID, messageID, partID },
    },
  };
}

function event(type: string): IngestEvent {
  return {
    streamEventType: 'kilocode',
    timestamp: type,
    data: { event: type, type, properties: {} },
  };
}

describe('running bash event coalescer', () => {
  it('forwards the first update immediately and later sends only the latest cumulative snapshot', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'a'));
    coalescer.forward(bashEvent('part-1', 'running', 'ab'));
    coalescer.forward(bashEvent('part-1', 'running', 'abc'));

    expect(sent.map(item => item.timestamp)).toEqual(['a']);
    scheduler.runNext();
    expect(sent.map(item => item.timestamp)).toEqual(['a', 'abc']);
  });

  it('does not repeat an immediate update when no newer snapshot arrives', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'only'));
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['only']);
  });

  it('coalesces running updates independently per part', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'one'));
    coalescer.forward(bashEvent('part-2', 'running', 'two'));
    coalescer.forward(bashEvent('part-1', 'running', 'one-latest'));
    coalescer.forward(bashEvent('part-2', 'running', 'two-latest'));
    scheduler.runNext();
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['one', 'two', 'one-latest', 'two-latest']);
  });

  it('does not coalesce matching part ids across messages or sessions', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'session-one'));
    coalescer.forward(bashEvent('part-1', 'running', 'message-two', 'session-1', 'message-2'));
    coalescer.forward(bashEvent('part-1', 'running', 'session-two', 'session-2', 'message-1'));

    expect(sent.map(item => item.timestamp)).toEqual(['session-one', 'message-two', 'session-two']);
  });

  it('scopes a session.idle boundary flush to that session only', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });
    const childIdle: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: 'child-idle',
      data: { event: 'session.idle', type: 'session.idle', properties: { sessionID: 'child' } },
    };

    coalescer.forward(bashEvent('part-1', 'running', 'root-first', 'root', 'msg-1'));
    coalescer.forward(bashEvent('part-1', 'running', 'root-pending', 'root', 'msg-1'));
    coalescer.forward(bashEvent('part-2', 'running', 'child-first', 'child', 'msg-1'));
    coalescer.forward(bashEvent('part-2', 'running', 'child-pending', 'child', 'msg-1'));
    coalescer.forward(childIdle);

    expect(sent.map(item => item.timestamp)).toEqual([
      'root-first',
      'child-first',
      'child-pending',
      'child-idle',
    ]);

    scheduler.runNext();
    expect(sent.map(item => item.timestamp)).toEqual([
      'root-first',
      'child-first',
      'child-pending',
      'child-idle',
      'root-pending',
    ]);
  });

  it('flushes pending snapshots in latest event arrival order', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'one'));
    coalescer.forward(bashEvent('part-2', 'running', 'two'));
    coalescer.forward(bashEvent('part-1', 'running', 'one-pending'));
    coalescer.forward(bashEvent('part-2', 'running', 'two-pending'));
    coalescer.forward(bashEvent('part-1', 'running', 'one-latest'));
    coalescer.forward(event('session.idle'));

    expect(sent.map(item => item.timestamp)).toEqual([
      'one',
      'two',
      'two-pending',
      'one-latest',
      'session.idle',
    ]);
  });

  it('expires inactive part state after one coalescing interval', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'first'));
    scheduler.runNext();
    coalescer.forward(bashEvent('part-1', 'running', 'after-idle'));

    expect(sent.map(item => item.timestamp)).toEqual(['first', 'after-idle']);
  });

  it('starts a fresh leading interval after a session boundary', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'first'));
    coalescer.forward(event('session.idle'));
    coalescer.forward(bashEvent('part-1', 'running', 'next-session'));

    expect(sent.map(item => item.timestamp)).toEqual(['first', 'session.idle', 'next-session']);
  });

  it('lets a terminal update supersede pending running output and prevents a stale timer send', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'partial'));
    coalescer.forward(bashEvent('part-1', 'running', 'newer-partial'));
    coalescer.forward(bashEvent('part-1', 'completed', 'final-full-output'));
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['partial', 'final-full-output']);
  });

  it('cancels a pending running update before forwarding part removal', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'partial'));
    coalescer.forward(bashEvent('part-1', 'running', 'stale-pending'));
    coalescer.forward(partRemovedEvent('part-1'));
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['partial', 'removed']);
  });

  it('flushes pending output before assistant completion', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });
    const completion: IngestEvent = {
      streamEventType: 'kilocode',
      timestamp: 'completion',
      data: {
        event: 'message.updated',
        properties: { info: { role: 'assistant', time: { completed: 1 } } },
      },
    };

    coalescer.forward(bashEvent('part-1', 'running', 'partial'));
    coalescer.forward(bashEvent('part-1', 'running', 'latest'));
    coalescer.forward(completion);
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['partial', 'latest', 'completion']);
  });

  it('flushes pending output before an interruption boundary', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });
    const interrupted: IngestEvent = {
      streamEventType: 'interrupted',
      timestamp: 'interrupted',
      data: { reason: 'user' },
    };

    coalescer.forward(bashEvent('part-1', 'running', 'partial'));
    coalescer.forward(bashEvent('part-1', 'running', 'latest'));
    coalescer.forward(interrupted);
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['partial', 'latest', 'interrupted']);
  });

  it('forwards new events after reopening for a warm follow-up', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(event('first-turn'));
    coalescer.close();
    coalescer.forward(event('between-turns'));
    coalescer.reopen();
    coalescer.forward(event('warm-follow-up'));

    expect(sent.map(item => item.timestamp)).toEqual(['first-turn', 'warm-follow-up']);
  });

  it('discards a pending throttled part and its timer when reopened without a prior close', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'a'));
    coalescer.forward(bashEvent('part-1', 'running', 'stale-pending'));
    coalescer.reopen();
    scheduler.runNext();
    coalescer.forward(bashEvent('part-1', 'running', 'fresh'));

    expect(sent.map(item => item.timestamp)).toEqual(['a', 'fresh']);
  });

  it('flushes pending output before completion and cannot send it after close', () => {
    const scheduler = createScheduler();
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent), callback => {
      const task = scheduler.schedule(callback);
      return () => scheduler.cancel(task);
    });

    coalescer.forward(bashEvent('part-1', 'running', 'partial'));
    coalescer.forward(bashEvent('part-1', 'running', 'latest'));
    coalescer.forward(event('session.idle'));
    coalescer.close();
    scheduler.runNext();

    expect(sent.map(item => item.timestamp)).toEqual(['partial', 'latest', 'session.idle']);
  });

  it('preserves non-bash and unrelated events without delay', () => {
    const sent: IngestEvent[] = [];
    const coalescer = createRunningBashEventCoalescer(sent.push.bind(sent));
    const nonBash = bashEvent('part-1', 'running', 'edit');
    const data = nonBash.data as { properties: { part: { tool: string } } };
    data.properties.part.tool = 'edit';

    coalescer.forward(nonBash);
    coalescer.forward(event('message.updated'));

    expect(sent).toEqual([nonBash, event('message.updated')]);
    coalescer.close();
  });
});
