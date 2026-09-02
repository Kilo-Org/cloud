import {
  appendCodeReviewDisplayEvent,
  toCodeReviewDisplayEvent,
} from './code-review-stream-events';
import type { CloudAgentEvent } from '@/lib/cloud-agent-next/event-types';

function event(streamEventType: string, data: unknown): CloudAgentEvent {
  return {
    eventId: 1,
    executionId: 'exec-1',
    sessionId: 'ses-1',
    streamEventType,
    timestamp: '2026-08-18T12:00:00.000Z',
    data,
  };
}

function kilocode(type: string, properties: unknown): CloudAgentEvent {
  return event('kilocode', { type, properties });
}

describe('toCodeReviewDisplayEvent', () => {
  it('shows started and complete stream events', () => {
    expect(toCodeReviewDisplayEvent(event('started', {}))).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Execution started',
      eventType: 'started',
    });
    expect(toCodeReviewDisplayEvent(event('complete', {}))).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Review completed',
      eventType: 'complete',
    });
  });

  it('shows live tool parts that use object state and part.tool', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            id: 'prt_read',
            type: 'tool',
            tool: 'read',
            state: { status: 'running', input: { path: '/src/bug.ts' } },
          },
        })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Tool: read',
      content: '/src/bug.ts',
      eventType: 'tool',
      key: 'prt_read',
    });
  });

  it('shows completed tool parts so mid-run reconnects still render progress', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            id: 'prt_bash',
            type: 'tool',
            name: 'bash',
            state: { status: 'completed', input: { command: 'ls src' } },
          },
        })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Tool: bash',
      content: 'ls src',
      eventType: 'tool',
      key: 'prt_bash',
    });
  });

  it('drops running tool ticks that have no part id', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            type: 'tool',
            tool: 'bash',
            state: { status: 'running', input: { command: 'sleep 10' } },
          },
        })
      )
    ).toBeNull();
  });

  it('skips pending tool parts', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            type: 'tool',
            tool: 'read',
            state: { status: 'pending', input: {} },
          },
        })
      )
    ).toBeNull();
  });

  it('shows canonical text parts while the review is running', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            id: 'prt_text',
            sessionID: 'ses-1',
            messageID: 'msg-1',
            type: 'text',
            text: 'Looking at the diff now.',
            time: { start: 1787054400000 },
          },
        })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Looking at the diff now.',
      eventType: 'text',
      key: 'prt_text',
    });
  });

  it('shows completed canonical text parts without a tool state', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            id: 'prt_text',
            sessionID: 'ses-1',
            messageID: 'msg-1',
            type: 'text',
            text: 'Review summary',
            time: { start: 1787054400000, end: 1787054401000 },
          },
        })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Review summary',
      eventType: 'text',
      key: 'prt_text',
    });
  });

  it.each(['', '   '])('skips empty text parts: %j', text => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: { id: 'prt_text', type: 'text', text },
        })
      )
    ).toBeNull();
  });

  it('updates a text part in place as new text arrives', () => {
    const partial = toCodeReviewDisplayEvent(
      kilocode('message.part.updated', {
        part: { id: 'prt_text', type: 'text', text: 'Looking at' },
      })
    );
    const updated = toCodeReviewDisplayEvent(
      kilocode('message.part.updated', {
        part: { id: 'prt_text', type: 'text', text: 'Looking at the diff now.' },
      })
    );
    expect(partial).not.toBeNull();
    expect(updated).not.toBeNull();
    if (!partial || !updated) return;
    expect(appendCodeReviewDisplayEvent([partial], updated)).toEqual([updated]);
  });

  it('shows session.status when status is an object', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('session.status', { sessionID: 'ses-1', status: { type: 'busy' } })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Agent working...',
      eventType: 'status',
    });
  });

  it('still accepts legacy string tool state and session status', () => {
    expect(
      toCodeReviewDisplayEvent(
        kilocode('message.part.updated', {
          part: {
            id: 'prt_grep',
            type: 'tool',
            name: 'grep',
            state: 'running',
            input: { query: 'TODO' },
          },
        })
      )
    ).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Tool: grep',
      content: 'TODO',
      eventType: 'tool',
      key: 'prt_grep',
    });
    expect(toCodeReviewDisplayEvent(kilocode('session.status', { status: 'idle' }))).toEqual({
      timestamp: '2026-08-18T12:00:00.000Z',
      message: 'Agent idle',
      eventType: 'status',
    });
  });

  it('replaces a keyed live event instead of appending another row', () => {
    const running = toCodeReviewDisplayEvent(
      kilocode('message.part.updated', {
        part: {
          id: 'prt_bash',
          type: 'tool',
          tool: 'bash',
          state: { status: 'running', input: { command: 'sleep 10' } },
        },
      })
    );
    const completed = toCodeReviewDisplayEvent(
      kilocode('message.part.updated', {
        part: {
          id: 'prt_bash',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'sleep 10' } },
        },
      })
    );
    expect(running).not.toBeNull();
    expect(completed).not.toBeNull();
    if (!running || !completed) return;
    expect(appendCodeReviewDisplayEvent([running], completed)).toEqual([completed]);
  });
});
