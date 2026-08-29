/* eslint-disable jest/no-conditional-in-test, promise/prefer-await-to-then -- Stateful guard fixtures distinguish synchronous throws from rejected promises. */
import { describe, expect, it } from 'vitest';
import { createEvalToolCall } from './agent-conversation';
import { ExecutionStoppedError, runToolCalls } from './agent-tool-results';
import type { ToolResultEvent } from './agent-tool-results';
import type { EvalTabResult } from './tab-debugger';

const firstToolCall = createEvalToolCall({ code: 'first', tabId: 1 });
const secondToolCall = createEvalToolCall({ code: 'second', tabId: 1 });

describe('agent tool results', () => {
  it('runs eval tool calls sequentially', async () => {
    const events: string[] = [];
    const results = await runToolCalls([firstToolCall, secondToolCall], async toolCall => {
      events.push(`start:${toolCall.code}`);
      await Promise.resolve();
      events.push(`end:${toolCall.code}`);
      return { ok: true, value: toolCall.code };
    });
    expect(events).toStrictEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(results).toMatchObject([
      { effectsUncertain: false, ok: true, toolCallId: firstToolCall.id, value: 'first' },
      { effectsUncertain: false, ok: true, toolCallId: secondToolCall.id, value: 'second' },
    ]);
  });

  it('preserves the issued result and stops later calls after Stop', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const results = await runToolCalls(
      [firstToolCall, secondToolCall],
      toolCall => {
        events.push(toolCall.code);
        controller.abort();
        return Promise.resolve({ ok: true, value: toolCall.code });
      },
      controller.signal
    );
    expect(events).toStrictEqual(['first']);
    expect(results).toMatchObject([
      { effectsUncertain: false, ok: true, toolCallId: firstToolCall.id, value: 'first' },
    ]);
  });

  it('performs no action when Stop precedes the batch', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const results = await runToolCalls(
      [firstToolCall],
      toolCall => {
        events.push(toolCall.code);
        return Promise.resolve({ ok: true });
      },
      controller.signal
    );
    expect({ events, results }).toStrictEqual({ events: [], results: [] });
  });

  const cases: {
    actions: string[];
    label: string;
    ok: boolean;
    result: EvalTabResult;
    uncertain: boolean;
  }[] = [
    {
      actions: ['first', 'second'],
      label: 'confirmed failure',
      ok: false,
      result: { effectsUncertain: false, error: 'Missing input.', ok: false },
      uncertain: false,
    },
    {
      actions: ['first', 'second'],
      label: 'legacy success',
      ok: true,
      result: { ok: true, value: 'observed' },
      uncertain: false,
    },
    {
      actions: ['first'],
      label: 'legacy issued failure',
      ok: false,
      result: { error: 'Lost response.', ok: false },
      uncertain: true,
    },
    {
      actions: ['first'],
      label: 'uncertain failure',
      ok: false,
      result: { effectsUncertain: true, error: 'Timed out.', ok: false },
      uncertain: true,
    },
    {
      actions: ['first'],
      label: 'uncertain success payload',
      ok: false,
      result: { effectsUncertain: true, ok: true, value: 'unconfirmed' },
      uncertain: true,
    },
  ];

  it.each(cases)(
    'preserves certainty for $label before another action',
    async ({ actions, ok, result, uncertain }) => {
      const events: string[] = [];
      const results = await runToolCalls([firstToolCall, secondToolCall], toolCall => {
        events.push(toolCall.code);
        return Promise.resolve(result);
      });
      expect(events).toStrictEqual(actions);
      expect(results[0]).toMatchObject({
        effectsUncertain: uncertain,
        ok,
      });
    }
  );

  it.each([
    {
      fail: (): Promise<EvalTabResult> => {
        throw new Error('Transport lost.');
      },
      label: 'synchronous throw',
    },
    {
      fail: (): Promise<EvalTabResult> => Promise.reject(new Error('Transport lost.')),
      label: 'rejection',
    },
  ])('stops the batch after a dispatched $label', async ({ fail }) => {
    const events: string[] = [];
    const results = await runToolCalls([firstToolCall, secondToolCall], toolCall => {
      events.push(toolCall.code);
      return fail();
    });
    expect(events).toStrictEqual(['first']);
    expect(results).toMatchObject([
      { effectsUncertain: true, error: 'eval failed: Transport lost.', ok: false },
    ]);
  });

  it('retains confirmed events when the lease ends between calls', async () => {
    let active = true;
    const actions: string[] = [];
    const settled: ToolResultEvent[] = [];
    const result = runToolCalls(
      [firstToolCall, secondToolCall],
      toolCall => {
        actions.push(toolCall.code);
        active = false;
        return Promise.resolve({ ok: true, value: 'issued and confirmed' });
      },
      undefined,
      {
        executionGuard: () => {
          if (!active) {
            throw new Error('lease_lost');
          }
        },
        onResult: event => settled.push(event),
      }
    );
    await expect(result).rejects.toMatchObject({
      effectsUncertain: false,
      reason: 'lease_lost',
      status: 'interrupted',
    });
    expect(actions).toStrictEqual(['first']);
    expect(settled).toMatchObject([{ ok: true, value: 'issued and confirmed' }]);
  });

  it.each([
    new DOMException('Stopped in flight.', 'AbortError'),
    new ExecutionStoppedError('lease_lost'),
    new ExecutionStoppedError('execution_timeout', 'interrupted', true),
  ])('propagates a stopped executor without a fabricated result: %s', async stopped => {
    const actions: string[] = [];
    const result = runToolCalls([firstToolCall, secondToolCall], toolCall => {
      actions.push(toolCall.code);
      return Promise.reject(stopped);
    });
    await expect(result).rejects.toBe(stopped);
    expect(actions).toStrictEqual(['first']);
  });
});
