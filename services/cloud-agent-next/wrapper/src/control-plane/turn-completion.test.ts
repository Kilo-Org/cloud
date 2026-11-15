import { describe, expect, it } from 'bun:test';
import { DrainSessionError } from '../kilo-api.js';
import type { Harness } from './harness.js';
import type { PendingPrompt, TurnKiloRuntime } from './turn.js';
import { createTurnCompletion } from './turn-completion.js';

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fixture(drain: NonNullable<Harness['drainSession']>) {
  const timers: Array<{ ms: number; handler(): void; cancelled: boolean }> = [];
  const outcomes: Array<{ status: string; reason?: string }> = [];
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  let active = true;
  let finalizations = 0;
  let executions: number[] | undefined = [];
  const tokens: string[] = [];
  const prompts = [{ dispatched: true, payload: {} }] as PendingPrompt[];
  const client = {
    async drainSession(input) {
      tokens.push(input.token ?? '');
      const result = await drain(input);
      if (result)
        completion.observe({
          type: 'session.drained',
          runtimeKey: '/workspace/test',
          nativeRuntimeId: 'runtime',
          directory: '/workspace/test',
          properties: { sessionID: 'ses_test', token: input.token },
        });
      return result;
    },
  } as Harness;
  const runtime = {
    client,
    nativeRuntimeId: 'runtime',
    isRestarting: () => false,
    isUnavailable: () => false,
    isRetiredClient: () => false,
    liveTreeExecutions: () => executions,
    sessionState: () => undefined,
  } as unknown as TurnKiloRuntime;
  const completion = createTurnCompletion({
    route: {
      sessionId: 'workspace_test',
      kiloSessionId: 'ses_test',
      directory: '/workspace/test',
      runtimeKey: '/workspace/test',
    },
    prompts: () => prompts,
    submission: () => Promise.resolve(),
    publication: () => undefined,
    runtime: () => runtime,
    isActive: () => active,
    scheduler: {
      setTimeout(handler, ms) {
        const timer = { handler, ms, cancelled: false };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle) {
        (handle as unknown as { cancelled: boolean }).cancelled = true;
      },
      setInterval,
      clearInterval,
    },
    quietDrainMs: 20 * 60_000,
    reserveDelivery() {},
    submitPublication: async () => {},
    autoCommit: async () => {},
    condense: async () => {},
    finalizing() {
      finalizations++;
    },
    log: message => diagnostics.push(message),
    warn: message => warnings.push(message),
    outcome(status, reason) {
      outcomes.push({ status, ...(reason ? { reason } : {}) });
      active = false;
    },
    nativeFailure(error) {
      throw error;
    },
  });
  return {
    completion,
    outcomes,
    diagnostics,
    warnings,
    tokens,
    finalizations: () => finalizations,
    setExecutions(value: number[] | undefined) {
      executions = value;
    },
    fire(ms: number) {
      const timer = timers.find(timer => timer.ms === ms && !timer.cancelled);
      if (!timer) throw new Error(`Missing ${ms}ms timer`);
      timer.cancelled = true;
      timer.handler();
    },
  };
}

function socketFailure() {
  return new DrainSessionError('transient', 'Kilo v2 drain request failed', {
    cause: Object.assign(new TypeError('socket connection closed'), { code: 'ECONNRESET' }),
  });
}

describe('completed assistant turn drain', () => {
  it('diagnoses a transient socket failure and completes only after a fresh paired retry', async () => {
    let attempts = 0;
    const h = fixture(async () => {
      if (++attempts === 1) throw socketFailure();
      return true;
    });
    h.completion.request('runtime');
    await settle();
    expect(h.outcomes).toEqual([]);
    expect(h.finalizations()).toBe(0);
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]).toContain('ECONNRESET');
    expect(h.diagnostics[0]).toContain('socket connection closed');
    expect(h.diagnostics[0]).toContain('"attempt":1');
    expect(h.diagnostics[0]).toContain('"elapsedMs":');
    h.fire(1_000);
    await settle();
    expect(h.outcomes).toEqual([{ status: 'completed' }]);
    expect(h.finalizations()).toBe(1);
    expect(new Set(h.tokens).size).toBe(2);
    expect(h.warnings).toEqual([]);
    h.completion.dispose();
  });

  it('never labels an answered turn no_outcome after exhausting socket retries', async () => {
    const h = fixture(async () => {
      throw socketFailure();
    });
    h.completion.request('runtime');
    await settle();
    h.fire(1_000);
    await settle();
    expect(h.outcomes).toEqual([]);
    h.fire(2_000);
    await settle();
    expect(h.outcomes).toEqual([{ status: 'failed', reason: 'completion_unconfirmed' }]);
    expect(h.outcomes.some(outcome => outcome.reason === 'no_outcome')).toBe(false);
    expect(h.diagnostics).toHaveLength(3);
    for (const [index, line] of h.diagnostics.entries()) {
      expect(line).toContain(`"attempt":${index + 1}`);
      expect(line).toContain('"elapsedMs":');
      expect(line).toContain('ECONNRESET');
      expect(line).toContain('socket connection closed');
    }
    expect(h.finalizations()).toBe(0);
    expect(h.tokens).toHaveLength(3);
    expect(h.warnings).toHaveLength(1);
    h.completion.dispose();
  });

  it('does not relabel an observed completed reply no_outcome when a child ends during a feed gap', async () => {
    const h = fixture(() => new Promise(() => {}));
    h.setExecutions([1]);
    h.completion.request('runtime');
    await settle();
    h.completion.onFeedInterrupted('runtime');
    h.setExecutions([]);
    h.completion.refresh();
    await settle();
    expect(h.outcomes).toEqual([{ status: 'failed', reason: 'completion_unconfirmed' }]);
    expect(h.warnings[0]).toContain('completion history is incomplete');
    h.completion.dispose();
  });
});
