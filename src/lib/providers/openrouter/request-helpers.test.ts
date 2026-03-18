import { addCacheBreakpoints } from './request-helpers';
import type { GatewayRequest } from './types';

type ResponsesRequest = Extract<GatewayRequest, { kind: 'responses' }>;

/** Retrieves the input array from a responses request, throwing if not an array. */
function getInputArray(request: ResponsesRequest): ResponsesRequest['body']['input'] & unknown[] {
  const { input } = request.body;
  if (!Array.isArray(input)) throw new Error('Expected input to be an array');
  return input;
}

describe('addCacheBreakpoints', () => {
  describe('chat_completions kind', () => {
    it('does nothing when there is only one message', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hello' }],
        },
      };
      addCacheBreakpoints(request);
      expect(request.body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('does nothing when there are no user or tool messages', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [
            { role: 'system', content: 'you are a bot' },
            { role: 'assistant', content: 'hi' },
          ],
        },
      };
      addCacheBreakpoints(request);
      expect(request.body.messages).toEqual([
        { role: 'system', content: 'you are a bot' },
        { role: 'assistant', content: 'hi' },
      ]);
    });

    it('sets cache_control on the last user message with string content', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'first message' },
            { role: 'user', content: 'second message' },
          ],
        },
      };
      addCacheBreakpoints(request);
      expect(request.body.messages[1].content).toEqual([
        {
          type: 'text',
          text: 'second message',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // First message should be untouched
      expect(request.body.messages[0].content).toBe('first message');
    });

    it('sets cache_control on the last item when content is an array', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'first' },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'part one' },
                { type: 'text', text: 'part two' },
              ],
            },
          ],
        },
      };
      addCacheBreakpoints(request);
      const content = request.body.messages[1].content as Array<{
        type: string;
        text: string;
        cache_control?: unknown;
      }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[1]).toMatchObject({
        type: 'text',
        text: 'part two',
        cache_control: { type: 'ephemeral' },
      });
      expect(content[0]).not.toHaveProperty('cache_control');
    });

    it('targets the last user or tool message, not the last message overall', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'user', content: 'second' },
            { role: 'assistant', content: 'assistant reply' },
          ],
        },
      };
      addCacheBreakpoints(request);
      // Assistant message should not be touched
      expect(request.body.messages[2].content).toBe('assistant reply');
      // The second user message should have cache_control applied
      expect(request.body.messages[1].content).toEqual([
        { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('sets cache_control on a tool message', () => {
      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
          ],
        },
      };
      addCacheBreakpoints(request);
      expect(request.body.messages[1].content).toEqual([
        { type: 'text', text: 'tool result', cache_control: { type: 'ephemeral' } },
      ]);
    });
  });

  describe('responses kind', () => {
    it('does nothing when there is only one input item', () => {
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [{ type: 'message', role: 'user', content: 'hello' }],
        },
      };
      addCacheBreakpoints(request);
      expect(getInputArray(request)).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
    });

    it('applies to last eligible user message when last overall is a non-user/tool item', () => {
      // A function_call (not function_call_output) is not eligible for cache breakpoints
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [
            { type: 'message', role: 'user', content: 'msg 1' },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'my_tool',
              arguments: '{}',
            },
          ],
        },
      };
      addCacheBreakpoints(request);
      const input = getInputArray(request);
      // Last eligible message is the user message at index 0
      const firstMsg = input[0] as { type: 'message'; role: string; content: unknown };
      expect(firstMsg.content).toEqual([
        { type: 'input_text', text: 'msg 1', cache_control: { type: 'ephemeral' } },
      ]);
      // function_call item untouched
      const fnCall = input[1] as { type: 'function_call'; arguments: string };
      expect(fnCall.arguments).toBe('{}');
    });

    it('sets cache_control on the last user message with string content', () => {
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [
            { type: 'message', role: 'user', content: 'first' },
            { type: 'message', role: 'user', content: 'second' },
          ],
        },
      };
      addCacheBreakpoints(request);
      const input = getInputArray(request);
      const lastInput = input[1] as { type: 'message'; role: string; content: unknown };
      expect(lastInput.content).toEqual([
        { type: 'input_text', text: 'second', cache_control: { type: 'ephemeral' } },
      ]);
      const firstInput = input[0] as { type: 'message'; role: string; content: unknown };
      expect(firstInput.content).toBe('first');
    });

    it('sets cache_control on function_call_output with string output', () => {
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [
            { type: 'message', role: 'user', content: 'run tool' },
            { type: 'function_call_output', call_id: 'call_1', output: 'tool result' },
          ],
        },
      };
      addCacheBreakpoints(request);
      const input = getInputArray(request);
      const toolOutput = input[1] as { type: 'function_call_output'; output: unknown };
      expect(toolOutput.output).toEqual([
        { type: 'input_text', text: 'tool result', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('sets cache_control on the last item of array content in a user message', () => {
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [
            { type: 'message', role: 'user', content: 'first' },
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'part one' },
                { type: 'input_text', text: 'part two' },
              ],
            },
          ],
        },
      };
      addCacheBreakpoints(request);
      const input = getInputArray(request);
      const lastInput = input[1] as {
        type: 'message';
        content: Array<{ type: string; text: string; cache_control?: unknown }>;
      };
      expect(lastInput.content[1]).toMatchObject({
        type: 'input_text',
        text: 'part two',
        cache_control: { type: 'ephemeral' },
      });
      expect(lastInput.content[0]).not.toHaveProperty('cache_control');
    });

    it('prefers the last function_call_output over an earlier user message', () => {
      const request: ResponsesRequest = {
        kind: 'responses',
        body: {
          model: 'test-model',
          input: [
            { type: 'message', role: 'user', content: 'run tool' },
            { type: 'function_call_output', call_id: 'call_1', output: 'first result' },
            { type: 'function_call_output', call_id: 'call_2', output: 'second result' },
          ],
        },
      };
      addCacheBreakpoints(request);
      const input = getInputArray(request);
      // Only the last function_call_output should be modified
      const firstToolOutput = input[1] as { type: 'function_call_output'; output: unknown };
      expect(firstToolOutput.output).toBe('first result');
      const secondToolOutput = input[2] as { type: 'function_call_output'; output: unknown };
      expect(secondToolOutput.output).toEqual([
        { type: 'input_text', text: 'second result', cache_control: { type: 'ephemeral' } },
      ]);
    });
  });

  describe('messages kind', () => {
    it('does nothing for messages kind requests', () => {
      const request: GatewayRequest = {
        kind: 'messages',
        body: {
          model: 'test-model',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'user', content: 'world' },
          ],
          max_tokens: 1024,
        },
      };
      const messagesCopy = JSON.parse(JSON.stringify(request.body.messages)) as unknown;
      addCacheBreakpoints(request);
      expect(request.body.messages).toEqual(messagesCopy);
    });
  });
});
