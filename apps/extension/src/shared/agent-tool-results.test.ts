import { describe, expect, it } from 'vitest';
import { createToolCall } from './agent-conversation';
import { runToolCalls } from './agent-tool-results';

describe('agent tool results', () => {
  it('runs browser tool calls sequentially', async () => {
    const events: string[] = [];
    const firstToolCall = createToolCall({
      arguments: { function: 'first' },
      name: 'kilo_browser_evaluate',
      tabId: 1,
    });
    const secondToolCall = createToolCall({
      arguments: { function: 'second' },
      name: 'kilo_browser_evaluate',
      tabId: 1,
    });

    const results = await runToolCalls([firstToolCall, secondToolCall], async toolCall => {
      const code = toolCall.arguments['function'];
      events.push(`start:${String(code)}`);
      await Promise.resolve();
      events.push(`end:${String(code)}`);
      return { ok: true, value: code };
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
    const firstToolCall = createToolCall({
      arguments: { function: 'first' },
      name: 'kilo_browser_evaluate',
      tabId: 1,
    });
    const secondToolCall = createToolCall({
      arguments: { function: 'second' },
      name: 'kilo_browser_evaluate',
      tabId: 1,
    });

    const results = await runToolCalls(
      [firstToolCall, secondToolCall],
      toolCall => {
        events.push(String(toolCall.arguments['function']));
        controller.abort();
        return Promise.resolve({ ok: true, value: toolCall.arguments['function'] });
      },
      controller.signal
    );

    expect(events).toStrictEqual(['first']);
    expect(results.map(result => result.toolCallId)).toStrictEqual([firstToolCall.id]);
  });
});
