import { describe, it, expect } from 'vitest';
import {
  applySessionLiveSummaryStatus,
  decideLiveSummaryPersist,
  EMPTY_SESSION_LIVE_SUMMARY_STATE,
  foldSessionLiveSummary,
  sessionLiveSummaryChanged,
  type SessionLiveBatchItem,
} from './session-live-summary';

const part = (
  tool: string,
  status: string,
  input: Record<string, unknown>
): SessionLiveBatchItem => ({
  type: 'part',
  data: { type: 'tool', tool, state: { status, input } },
});

const run = (batch: readonly SessionLiveBatchItem[], status: string | null = 'busy') =>
  foldSessionLiveSummary(EMPTY_SESSION_LIVE_SUMMARY_STATE, batch, status);

describe('foldSessionLiveSummary', () => {
  it('maps an editing tool to its file basename', () => {
    expect(run([part('edit', 'running', { filePath: '/home/user/project/src/index.ts' })])).toEqual(
      {
        step: { verb: 'editing', target: 'index.ts' },
        plan: null,
        changes: null,
        failure: null,
      }
    );
  });
  it('reads file paths from file_path and path keys', () => {
    expect(run([part('write', 'pending', { file_path: 'a/b/c.md' })]).step?.target).toBe('c.md');
    expect(run([part('apply_patch', 'running', { path: 'x/y.tsx' })]).step).toEqual({
      verb: 'editing',
      target: 'y.tsx',
    });
  });

  it('keeps a file basename to the characters it draws', () => {
    expect(
      run([part('edit', 'running', { filePath: 'src/report\u202Efdp.exe' })]).step?.target
    ).toBe('reportfdp.exe');
  });

  it('maps read to a reading step', () => {
    expect(run([part('read', 'running', { filePath: '/tmp/a/notes.txt' })]).step).toEqual({
      verb: 'reading',
      target: 'notes.txt',
    });
  });

  it('maps bash to a running step with the trimmed command', () => {
    const long = `pnpm ${'x'.repeat(80)}`;
    const step = run([part('bash', 'running', { command: long })]).step;
    expect(step?.verb).toBe('running');
    expect(step?.target?.length).toBeLessThanOrEqual(40);
    expect(step?.target?.endsWith('…')).toBe(true);
  });

  it('maps search tools to searching with their target', () => {
    expect(run([part('grep', 'running', { pattern: 'needle' })]).step).toEqual({
      verb: 'searching',
      target: 'needle',
    });
    expect(run([part('glob', 'running', { pattern: 'src/**/*.ts' })]).step?.verb).toBe('searching');
    expect(run([part('list', 'running', { path: '/a/b/c' })]).step).toEqual({
      verb: 'searching',
      target: 'c',
    });
    expect(run([part('codesearch', 'running', { query: 'how does it work' })]).step?.verb).toBe(
      'searching'
    );
    expect(run([part('websearch', 'running', { query: 'drizzle jsonb' })]).step?.target).toBe(
      'drizzle jsonb'
    );
    expect(
      run([part('webfetch', 'running', { url: 'https://docs.example.com/a/b' })]).step
    ).toEqual({ verb: 'searching', target: 'docs.example.com' });
  });

  it('maps unknown tools to other with no target', () => {
    expect(run([part('task', 'running', { description: 'do it' })]).step).toEqual({
      verb: 'other',
      target: null,
    });
    expect(run([part('mcp__thing__do', 'pending', {})]).step).toEqual({
      verb: 'other',
      target: null,
    });
  });

  it('ignores a completed tool part and keeps a pending one', () => {
    const completed = run([part('edit', 'completed', { filePath: 'a.ts' })]);
    expect(completed.step).toBeNull();
    const both = run([
      part('edit', 'running', { filePath: 'a.ts' }),
      part('bash', 'completed', { command: 'ls' }),
    ]);
    expect(both.step).toEqual({ verb: 'editing', target: 'a.ts' });
  });

  it('uses the newest pending or running part when a batch carries several', () => {
    expect(
      run([
        part('read', 'running', { filePath: 'a.ts' }),
        part('bash', 'running', { command: 'ls' }),
      ]).step
    ).toEqual({ verb: 'running', target: 'ls' });
  });

  it('shows thinking for a reasoning part while busy', () => {
    expect(run([{ type: 'part', data: { type: 'reasoning' } }], 'busy').step).toEqual({
      verb: 'thinking',
      target: null,
    });
    expect(run([{ type: 'part', data: { type: 'reasoning' } }], 'idle').step).toBeNull();
  });

  it('never uses text part content', () => {
    const state = run([{ type: 'part', data: { type: 'text', text: 'secret prompt' } }]);
    expect(JSON.stringify(state)).not.toContain('secret prompt');
    expect(state.step).toBeNull();
  });

  it('builds the plan from todowrite todos, excluding cancelled', () => {
    const state = run([
      part('todowrite', 'running', {
        todos: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'in_progress' },
          { content: 'third', status: 'pending' },
          { content: 'fourth', status: 'cancelled' },
        ],
      }),
    ]);
    expect(state.plan).toEqual({ done: 1, total: 3, current: 'second' });
  });

  it('drops the plan when every todo is cancelled', () => {
    const state = run([
      part('todowrite', 'running', { todos: [{ content: 'never', status: 'cancelled' }] }),
    ]);
    expect(state.plan).toBeNull();
  });

  it('sums the session diff snapshot', () => {
    const state = run([
      {
        type: 'session_diff',
        data: [
          { file: 'a.ts', additions: 3, deletions: 1 },
          { file: 'b.ts', additions: 2, deletions: 4 },
        ],
      },
    ]);
    expect(state.changes).toEqual({ files: 2, added: 5, removed: 5 });
  });

  it('reads an empty diff as no changes', () => {
    expect(run([{ type: 'session_diff', data: [] }]).changes).toEqual({
      files: 0,
      added: 0,
      removed: 0,
    });
  });

  it('maps assistant errors to failure kinds', () => {
    const message = (error: Record<string, unknown>): SessionLiveBatchItem => ({
      type: 'message',
      data: { role: 'assistant', error },
    });
    expect(
      run([message({ name: 'ProviderAuthError', data: { providerID: 'p', message: 'x' } })], null)
        .failure
    ).toEqual({ kind: 'provider' });
    expect(
      run([message({ name: 'APIError', data: { message: 'x', isRetryable: true } })], null).failure
    ).toEqual({ kind: 'provider' });
    expect(
      run([message({ name: 'MessageAbortedError', data: { message: 'x' } })], null).failure
    ).toEqual({ kind: 'cancelled' });
    expect(run([message({ name: 'UnknownError', data: { message: 'x' } })], null).failure).toEqual({
      kind: 'other',
    });
  });

  it('maps session_close reasons to failure kinds', () => {
    expect(run([{ type: 'session_close', data: { reason: 'error' } }], null).failure).toEqual({
      kind: 'other',
    });
    expect(run([{ type: 'session_close', data: { reason: 'interrupted' } }], null).failure).toEqual(
      {
        kind: 'cancelled',
      }
    );
  });

  it('reads an errored tool part as a tool failure', () => {
    const state = run([part('bash', 'error', { command: 'false' })], null);
    expect(state.failure).toEqual({ kind: 'tool' });
    expect(state.step).toBeNull();
  });

  it('clears the failure when the batch reports a new turn', () => {
    const failed = run(
      [
        {
          type: 'message',
          data: {
            role: 'assistant',
            error: { name: 'APIError', data: { message: 'boom', isRetryable: true } },
          },
        },
      ],
      null
    );
    expect(failed.failure).toEqual({ kind: 'provider' });
    const next = foldSessionLiveSummary(
      failed,
      [part('edit', 'running', { filePath: 'a.ts' })],
      'busy'
    );
    expect(next.failure).toBeNull();
  });

  it('keeps the prior failure when no status transition is reported', () => {
    const failed = run([{ type: 'session_close', data: { reason: 'error' } }], null);
    const next = foldSessionLiveSummary(failed, [part('bash', 'running', { command: 'ls' })], null);
    expect(next.failure).toEqual({ kind: 'other' });
  });

  it('applies a busy transition by clearing the failure', () => {
    const failed = { ...EMPTY_SESSION_LIVE_SUMMARY_STATE, failure: { kind: 'provider' as const } };
    expect(applySessionLiveSummaryStatus(failed, 'busy').failure).toBeNull();
  });

  it('applies an idle transition by clearing the step and plan', () => {
    const active = {
      step: { verb: 'editing' as const, target: 'a.ts' },
      plan: { done: 1, total: 2, current: 'b' },
      changes: { files: 1, added: 1, removed: 0 },
      failure: null,
    };
    const idle = applySessionLiveSummaryStatus(active, 'idle');
    expect(idle.step).toBeNull();
    expect(idle.plan).toBeNull();
    expect(idle.changes).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it('reports a visible change only when a drawn field moves', () => {
    const base = {
      ...EMPTY_SESSION_LIVE_SUMMARY_STATE,
      step: { verb: 'editing' as const, target: 'a' },
    };
    expect(sessionLiveSummaryChanged(base, { ...base })).toBe(false);
    expect(
      sessionLiveSummaryChanged(base, { ...base, step: { verb: 'reading', target: 'a' } })
    ).toBe(true);
  });
});

describe('decideLiveSummaryPersist', () => {
  it('always persists on a status transition or a failure change', () => {
    expect(
      decideLiveSummaryPersist({
        nowMs: 1_000,
        statusTransition: true,
        failureChanged: false,
        lastPersistedAtMs: 999,
      })
    ).toBe(true);
    expect(
      decideLiveSummaryPersist({
        nowMs: 1_000,
        statusTransition: false,
        failureChanged: true,
        lastPersistedAtMs: 999,
      })
    ).toBe(true);
  });

  it('throttles a plain change to one write per window', () => {
    expect(
      decideLiveSummaryPersist({
        nowMs: 5_000,
        statusTransition: false,
        failureChanged: false,
        lastPersistedAtMs: 4_000,
      })
    ).toBe(false);
    expect(
      decideLiveSummaryPersist({
        nowMs: 15_000,
        statusTransition: false,
        failureChanged: false,
        lastPersistedAtMs: 4_000,
      })
    ).toBe(true);
    expect(
      decideLiveSummaryPersist({
        nowMs: 1,
        statusTransition: false,
        failureChanged: false,
        lastPersistedAtMs: null,
      })
    ).toBe(true);
  });
});
