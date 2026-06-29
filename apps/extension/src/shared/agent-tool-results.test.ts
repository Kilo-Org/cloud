import { describe, expect, it } from 'vitest';
import { createEvalToolCall } from './agent-conversation';
import { runToolCalls } from './agent-tool-results';

describe('agent tool results', () => {
  it('runs eval tool calls sequentially', async () => {
    const events: string[] = [];
    const firstToolCall = createEvalToolCall({ code: 'first', tabId: 1 });
    const secondToolCall = createEvalToolCall({ code: 'second', tabId: 1 });

    const results = await runToolCalls([firstToolCall, secondToolCall], async toolCall => {
      events.push(`start:${toolCall.code}`);
      await Promise.resolve();
      events.push(`end:${toolCall.code}`);
      return { ok: true, value: toolCall.code };
    });

    expect(events).toStrictEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(results.map(result => result.toolCallId)).toStrictEqual([
      firstToolCall.id,
      secondToolCall.id,
    ]);
  });

  it('stops before later tool calls once the signal is aborted', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const firstToolCall = createEvalToolCall({ code: 'first', tabId: 1 });
    const secondToolCall = createEvalToolCall({ code: 'second', tabId: 1 });

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
    expect(results.map(result => result.toolCallId)).toStrictEqual([firstToolCall.id]);
  });
});
