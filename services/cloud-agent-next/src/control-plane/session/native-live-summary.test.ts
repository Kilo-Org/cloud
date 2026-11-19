import { describe, expect, it, vi } from 'vitest';
import type { Kilo2Message } from '@kilocode/session-ingest-contracts';
import {
  createNativeLiveSummary,
  EMPTY_NATIVE_LIVE_SUMMARY_STATE,
  foldNativeLiveSummary,
} from './native-live-summary.js';

vi.mock('../../logger.js', () => ({
  logger: { warn: vi.fn(), withFields: () => ({ warn: vi.fn() }) },
}));

type Content = NonNullable<Kilo2Message['content']>[number];

function assistant(content: Content[], extra: Partial<Kilo2Message> = {}): Kilo2Message {
  return { id: 'msg_answer', type: 'assistant', time: { created: 1 }, content, ...extra };
}

function tool(name: string, status: 'streaming' | 'running' | 'completed' | 'error', input = {}) {
  return { type: 'tool', id: `call_${name}`, name, state: { status, input } } satisfies Content;
}

const todos = {
  todos: [
    { content: 'Read the code', status: 'completed' },
    { content: 'Write the tests', status: 'in_progress' },
    { content: 'Dropped', status: 'cancelled' },
  ],
};

describe('native live summary', () => {
  it('names the last started tool as the step and the last todowrite as the plan', () => {
    const state = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([
        tool('todowrite', 'completed', todos),
        tool('read', 'completed', { filePath: '/workspace/app/README.md' }),
        tool('edit', 'running', { filePath: '/workspace/app/src/index.ts' }),
        { type: 'text', text: 'Editing' },
      ])
    );
    expect(state.summary).toEqual({
      step: { verb: 'editing', target: 'index.ts' },
      plan: { done: 1, total: 2, current: 'Write the tests' },
      changes: null,
      failure: null,
    });
  });

  it('runs a Kilo v2 shell call like a Kilo v1 bash call', () => {
    const state = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([tool('shell', 'running', { command: 'pnpm test' })])
    );
    expect(state.summary.step).toEqual({ verb: 'running', target: 'pnpm test' });
  });

  it('maps a Kilo v2 web fetch to its host and falls back to the text', () => {
    const fetched = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([tool('webfetch', 'running', { url: 'https://docs.example.com:8443/a?b=1' })])
    );
    expect(fetched.summary.step).toEqual({ verb: 'searching', target: 'docs.example.com:8443' });
    const unparsed = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([tool('webfetch', 'running', { url: 'docs.example.com/a' })])
    );
    expect(unparsed.summary.step).toEqual({ verb: 'searching', target: 'docs.example.com/a' });
  });

  it('keeps the step of a finished tool and thinks only on unfinished trailing reasoning', () => {
    const started = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([tool('grep', 'running', { pattern: 'TODO' })])
    );
    const finished = foldNativeLiveSummary(
      started,
      assistant([
        { type: 'reasoning', text: 'Planning', time: { created: 1, completed: 2 } },
        tool('grep', 'completed', { pattern: 'TODO' }),
      ])
    );
    expect(finished.summary.step).toEqual({ verb: 'searching', target: 'TODO' });
    const thinking = foldNativeLiveSummary(
      finished,
      assistant([
        tool('grep', 'completed', { pattern: 'TODO' }),
        { type: 'reasoning', text: 'Next', time: { created: 3 } },
      ])
    );
    expect(thinking.summary.step).toEqual({ verb: 'thinking', target: null });
  });

  it.each([
    ['aborted', 'cancelled'],
    ['provider.internal', 'provider'],
    ['tool.execution', 'tool'],
    ['unknown', 'other'],
  ] as const)('reports a %s assistant error as a %s failure', (type, kind) => {
    const state = foldNativeLiveSummary(
      EMPTY_NATIVE_LIVE_SUMMARY_STATE,
      assistant([], { error: { type, message: 'failed' } })
    );
    expect(state.summary.failure).toEqual({ kind });
  });

  it('starts a new turn with an empty summary on a new user message only', () => {
    const user = (id: string): Kilo2Message => ({ id, type: 'user', time: { created: 1 } });
    const first = foldNativeLiveSummary(EMPTY_NATIVE_LIVE_SUMMARY_STATE, user('msg_first'));
    const failed = foldNativeLiveSummary(
      first,
      assistant([tool('todowrite', 'completed', todos)], {
        error: { type: 'aborted', message: 'stopped' },
      })
    );
    // A repeated update of the message that opened the turn keeps it.
    expect(foldNativeLiveSummary(failed, user('msg_first'))).toBe(failed);
    expect(foldNativeLiveSummary(failed, user('msg_second'))).toEqual({
      turn: 'msg_second',
      summary: { step: null, plan: null, changes: null, failure: null },
    });
  });

  it('ends a turn on the root idle status and starts the next one on busy', () => {
    const values = new Map<string, unknown>();
    const storage = {
      kv: {
        get: (key: string) => values.get(key),
        put: (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
        delete: (key: string) => values.delete(key),
      },
    } as Pick<DurableObjectStorage, 'kv'>;
    const summary = createNativeLiveSummary(storage);
    const root = 'ses_root';
    const updated = (sessionID: string, message: Kilo2Message) => ({
      type: 'conversation.message.updated',
      properties: {
        sessionID,
        source: {
          version: 'v2',
          session: {
            id: sessionID,
            location: { directory: '/workspace' },
            time: { created: 1, updated: 2 },
          },
        },
        message,
      },
    });
    const status = (sessionID: string, type: string) => ({
      type: 'session.status',
      properties: { sessionID, status: { type } },
    });
    // Kilo v1 has no native transcript, so its idle status starts no summary.
    summary.observe(status(root, 'idle'), root);
    expect(summary.settled('busy')).toBeUndefined();
    summary.observe(
      updated(
        root,
        assistant(
          [tool('todowrite', 'completed', todos), tool('edit', 'running', { filePath: 'a.ts' })],
          { error: { type: 'aborted', message: 'stopped' } }
        )
      ),
      root
    );
    // A subagent's message is not the root's summary.
    summary.observe(
      updated('ses_child', assistant([tool('read', 'running', { filePath: 'b.ts' })])),
      root
    );
    const working = {
      step: { verb: 'editing', target: 'a.ts' },
      plan: { done: 1, total: 2, current: 'Write the tests' },
      changes: null,
      failure: { kind: 'cancelled' },
    };
    const finished = { step: null, plan: null, changes: null, failure: { kind: 'cancelled' } };
    expect(summary.settled('busy')).toEqual(working);
    // An idle or failed snapshot shows no step or plan without changing the stored summary.
    expect(summary.settled('idle')).toEqual(finished);
    expect(summary.settled('failed')).toEqual(finished);
    expect(summary.settled('busy')).toEqual(working);
    // A subagent going idle does not end the root's turn.
    summary.observe(status('ses_child', 'idle'), root);
    expect(summary.settled('busy')).toEqual(working);
    // The root going idle ends the turn without clearing its failure.
    summary.observe(status(root, 'idle'), root);
    expect(summary.settled('busy')).toEqual(finished);
    // The next turn opens with a busy status and no root user message: it clears the failure of
    // the turn before it, as the Kilo v1 busy transition does.
    summary.observe(status(root, 'busy'), root);
    expect(summary.settled('busy')).toEqual({
      step: null,
      plan: null,
      changes: null,
      failure: null,
    });
    // A repeated busy status keeps the cleared value.
    summary.observe(status(root, 'busy'), root);
    expect(summary.settled('busy')).toEqual({
      step: null,
      plan: null,
      changes: null,
      failure: null,
    });
  });
});
