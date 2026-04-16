import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { repairTools } from './tool-calling';

function createRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): OpenRouterChatCompletionRequest {
  return {
    model: 'test-model',
    messages: [],
    ...overrides,
  };
}

describe('repairTools', () => {
  describe('spurious tool result removal', () => {
    it('should remove tool results without matching tool calls', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', tool_call_id: 'orphan_id', content: 'Orphan result' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('should keep tool results that have matching tool calls', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(3);
    });

    it('should remove multiple orphan tool results', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', tool_call_id: 'orphan_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'orphan_2', content: 'Result 2' },
          { role: 'assistant', content: 'Response' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(2);
      expect(request.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    });
  });

  describe('missing tool result insertion', () => {
    it('should insert missing tool results after assistant message', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(4);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Tool execution was interrupted before completion.',
      });
    });

    it('should insert multiple missing tool results for multiple tool calls', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(5);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Tool execution was interrupted before completion.',
      });
      expect(request.messages[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'Tool execution was interrupted before completion.',
      });
    });

    it('should only insert results for tool calls without existing results', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Existing result' },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      // Missing result for call_2 is inserted right after the assistant message
      // So the order becomes: user, assistant, call_2_result (inserted), call_1_result (existing), user
      expect(request.messages).toHaveLength(5);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'Tool execution was interrupted before completion.',
      });
      expect(request.messages[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Existing result',
      });
    });

    it('should handle assistant messages without tool_calls', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Just a response' },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(3);
    });

    it('should handle multiple assistant messages with tool calls', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'Another request' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(6);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Tool execution was interrupted before completion.',
      });
      expect(request.messages[5]).toEqual({
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'Tool execution was interrupted before completion.',
      });
    });
  });

  describe('combined scenarios', () => {
    it('should handle orphan removal and missing result insertion together', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', tool_call_id: 'orphan', content: 'Orphan result' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      // Orphan removed, missing result inserted
      expect(request.messages).toHaveLength(4);
      expect(request.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Tool execution was interrupted before completion.',
      });
    });

    it('should properly repair a complex conversation', () => {
      const request = createRequest({
        tools: [
          { type: 'function', function: { name: 'read_file', parameters: {} } },
          { type: 'function', function: { name: 'write_file', parameters: {} } },
        ],
        messages: [
          { role: 'user', content: 'Read and update the file' },
          {
            role: 'assistant',
            content: "I'll read the file first",
            tool_calls: [
              {
                id: 'read_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path": "test.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'read_1', content: 'File contents here' },
          {
            role: 'assistant',
            content: "Now I'll update it",
            tool_calls: [
              {
                id: 'write_1',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path": "test.txt"}' },
              },
            ],
          },
          // Missing tool result for write_1
          { role: 'tool', tool_call_id: 'stray_result', content: 'Stray result' },
          { role: 'user', content: 'What happened?' },
        ],
      });

      repairTools(request);

      // Stray result removed, missing result inserted
      expect(request.messages).toHaveLength(6);
      expect(request.messages[4]).toEqual({
        role: 'tool',
        tool_call_id: 'write_1',
        content: 'Tool execution was interrupted before completion.',
      });
    });
  });

  describe('edge cases', () => {
    it('should handle undefined messages without throwing', () => {
      const request = createRequest({
        messages: undefined as unknown as OpenRouterChatCompletionRequest['messages'],
      });

      repairTools(request);

      expect(request.messages).toBeUndefined();
    });

    it('should handle empty messages array', () => {
      const request = createRequest({ messages: [] });

      repairTools(request);

      expect(request.messages).toEqual([]);
    });

    it('should handle conversation with only user messages', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'user', content: 'Are you there?' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(2);
    });

    it('should handle assistant with empty tool_calls array', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Response', tool_calls: [] },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(2);
    });

    it('should handle system messages correctly', () => {
      const request = createRequest({
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(4);
    });

    it('should allow tool call ids to be reused across different turns', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'First request' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'First result' },
          { role: 'user', content: 'Second request' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              // Same id as first turn - should be allowed
              { id: 'call_1', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Second result' },
        ],
      });

      repairTools(request);

      // All messages should remain - both tool results match their respective tool calls
      expect(request.messages).toHaveLength(6);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'First result',
      });
      expect(request.messages[5]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Second result',
      });
    });
  });

  describe('duplicate tool use handling', () => {
    it('should remove duplicate tool calls with the same id in an assistant message', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(3);
      const assistantMsg = request.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      if (assistantMsg.role === 'assistant') {
        expect(assistantMsg.tool_calls).toHaveLength(1);
      }
    });

    it('should remove duplicate tool results with the same tool_call_id', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'First result' },
          { role: 'tool', tool_call_id: 'call_1', content: 'Duplicate result' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(3);
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'First result',
      });
    });

    it('should keep first of each tool call when multiple tool calls have duplicates', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'tool_a', arguments: '{"a":1}' },
              },
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'tool_a', arguments: '{"a":2}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'tool_b', arguments: '{"b":1}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'Result 2' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(4);
      const assistantMsg = request.messages[1];
      expect(assistantMsg.role).toBe('assistant');
      if (assistantMsg.role === 'assistant') {
        expect(assistantMsg.tool_calls).toHaveLength(2);
        expect(assistantMsg.tool_calls?.[0]).toEqual({
          id: 'call_1',
          type: 'function',
          function: { name: 'tool_a', arguments: '{"a":1}' },
        });
        expect(assistantMsg.tool_calls?.[1]).toEqual({
          id: 'call_2',
          type: 'function',
          function: { name: 'tool_b', arguments: '{}' },
        });
      }
    });

    it('should handle duplicate tool calls when some results are missing', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      });

      repairTools(request);

      // Should deduplicate to single tool call, then insert missing result
      expect(request.messages).toHaveLength(4);
      const assistantMsg = request.messages[1];
      if (assistantMsg.role === 'assistant') {
        expect(assistantMsg.tool_calls).toHaveLength(1);
      }
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Tool execution was interrupted before completion.',
      });
    });

    it('should handle combined duplicate tool calls and duplicate tool results', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'call_1', content: 'Duplicate result 1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'Result 2' },
          { role: 'tool', tool_call_id: 'call_2', content: 'Duplicate result 2' },
        ],
      });

      repairTools(request);

      // Duplicate tool calls removed (2 unique), duplicate results removed
      expect(request.messages).toHaveLength(4);
      const assistantMsg = request.messages[1];
      if (assistantMsg.role === 'assistant') {
        expect(assistantMsg.tool_calls).toHaveLength(2);
      }
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Result 1',
      });
      expect(request.messages[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'Result 2',
      });
    });

    it('should handle triple duplicates of both tool calls and results', () => {
      const request = createRequest({
        messages: [
          { role: 'user', content: 'Hello' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 2' },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 3' },
        ],
      });

      repairTools(request);

      expect(request.messages).toHaveLength(3);
      const assistantMsg = request.messages[1];
      if (assistantMsg.role === 'assistant') {
        expect(assistantMsg.tool_calls).toHaveLength(1);
      }
      expect(request.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Result 1',
      });
    });
  });
});
