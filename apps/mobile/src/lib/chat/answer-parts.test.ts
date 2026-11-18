import { type Part } from '@kilocode/cloud-agent-sdk';
import { buildToolDetail } from '@kilocode/app-shared/tool-detail';
import { type ModelEvent, zeroUsage } from '@kilocode/harness-sdk';
import { describe, expect, it } from 'vitest';

import { answerParts } from './answer-parts';

const call = (id: string, name: string, args = '{}'): ModelEvent => ({
  kind: 'toolCall',
  call: { id, name, arguments: args },
});

const done: ModelEvent = { kind: 'done', usage: zeroUsage, stop: 'tools' };

function read(events: readonly ModelEvent[]): readonly Part[] {
  let parts: readonly Part[] = [];
  for (const [index, event] of events.entries()) {
    parts = answerParts({ sessionId: 's1', parts, event, now: index + 1 });
  }
  return parts;
}

describe('answerParts', () => {
  it.each(['time', 'mcp_kilo_search', 'web_search'])(
    'shows %s pending, running, then completed under the same inspectable part',
    name => {
      const pending = read([call('c1', name, '{"query":"today"}')]);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        type: 'tool',
        callID: 'c1',
        tool: name,
        state: { status: 'pending', input: { query: 'today' }, raw: '{"query":"today"}' },
      });
      const running = answerParts({ sessionId: 's1', parts: pending, event: done, now: 2 });
      expect(running[0]).toMatchObject({
        id: pending[0]?.id,
        state: { status: 'running', input: { query: 'today' }, time: { start: 2 } },
      });
      const completed = answerParts({
        sessionId: 's1',
        parts: running,
        event: {
          kind: 'toolResult',
          result: { callId: 'c1', body: '{"answer":"now"}', failed: false },
        },
        now: 3,
      });
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        id: pending[0]?.id,
        state: { status: 'completed', title: name, time: { start: 2, end: 3 } },
      });
      const part = completed[0];
      if (part?.type !== 'tool') {
        throw new Error('expected a tool part');
      }
      expect(buildToolDetail(part)).toMatchObject({
        status: 'completed',
        arguments: { query: 'today' },
        output: { text: expect.stringContaining('now'), isJson: true },
      });
    }
  );

  it('keeps text, reasoning, parallel tools and follow-up text in arrival order', () => {
    const parts = read([
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'reasoning', text: ' aloud' },
      { kind: 'delta', text: 'Checking ' },
      { kind: 'delta', text: 'now.' },
      call('c1', 'time'),
      call('c2', 'web_search', '{"query":"news"}'),
      done,
      { kind: 'toolResult', result: { callId: 'c2', body: 'news', failed: false } },
      { kind: 'toolResult', result: { callId: 'c1', body: 'no clock', failed: true } },
      { kind: 'delta', text: 'Here ' },
      { kind: 'delta', text: 'it is.' },
    ]);
    expect(parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool', 'tool', 'text']);
    expect(parts[0]).toMatchObject({ text: 'thinking aloud', time: { end: 7 } });
    expect(parts[1]).toMatchObject({ text: 'Checking now.' });
    expect(parts[2]).toMatchObject({ callID: 'c1', state: { status: 'error', error: 'no clock' } });
    expect(parts[3]).toMatchObject({
      callID: 'c2',
      state: { status: 'completed', output: 'news' },
    });
    expect(parts[4]).toMatchObject({ text: 'Here it is.' });
    expect(new Set(parts.map(part => part.id)).size).toBe(parts.length);
  });

  it.each(['{"query":', 'null', '[1,2]', '"hello"'])(
    'keeps non-object arguments inspectable after failure: %s',
    raw => {
      const parts = read([
        call('c1', 'web_search', raw),
        done,
        { kind: 'toolResult', result: { callId: 'c1', body: 'invalid arguments', failed: true } },
      ]);
      const part = parts[0];
      if (part?.type !== 'tool') {
        throw new Error('expected a tool part');
      }
      expect(buildToolDetail(part)).toMatchObject({
        status: 'error',
        arguments: { arguments: raw },
        error: 'invalid arguments',
      });
    }
  );

  it('does not create result bubbles or overwrite an earlier reused call id', () => {
    const parts = read([
      call('c1', 'time'),
      done,
      { kind: 'toolResult', result: { callId: 'c1', body: 'first', failed: false } },
      call('c1', 'time'),
      done,
      { kind: 'toolResult', result: { callId: 'c1', body: 'second', failed: false } },
      { kind: 'toolResult', result: { callId: 'unmatched', body: 'ignored', failed: false } },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ state: { status: 'completed', output: 'first' } });
    expect(parts[1]).toMatchObject({ state: { status: 'completed', output: 'second' } });
  });

  it('never exposes encrypted reasoning or empty deltas', () => {
    expect(
      read([
        { kind: 'redacted', data: 'secret' },
        { kind: 'delta', text: '' },
      ])
    ).toEqual([]);
  });
});
