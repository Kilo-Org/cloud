import { describe, expect, it } from 'vitest';
import { createToolCall, createToolResult } from './agent-conversation';
import { toPersistedConversationEvents } from './agent-conversation-persistence';

describe('agent conversation persistence', () => {
  it('strips browser screenshot image data before storage', () => {
    const toolCall = createToolCall({
      arguments: { scale: 'css' },
      name: 'kilo_browser_take_screenshot',
      tabId: 1,
    });
    const toolResult = createToolResult({
      ok: true,
      toolCallId: toolCall.id,
      value: {
        dataUrl: 'data:image/png;base64,c2VjcmV0',
        mediaType: 'image/png',
      },
    });

    expect(toPersistedConversationEvents([toolCall, toolResult])).toStrictEqual([
      toolCall,
      {
        ...toolResult,
        value: {
          mediaType: 'image/png',
          note: 'Viewport screenshot omitted from persisted history.',
        },
      },
    ]);
  });
});
