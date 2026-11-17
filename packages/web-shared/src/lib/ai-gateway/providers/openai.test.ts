import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { applyOpenAiModelSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/openai';

const LONG_ID = 'call_'.repeat(13);
const MAX_LENGTH_ID = 'x'.repeat(64);

describe('applyOpenAiModelSettings tool call ids', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('normalizes chat completions tool call ids longer than 64 characters consistently', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'openai/gpt-6.1-sol',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: LONG_ID, type: 'function', function: { name: 'read', arguments: '{}' } },
              { id: MAX_LENGTH_ID, type: 'function', function: { name: 'read', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: LONG_ID, content: 'one' },
          { role: 'tool', tool_call_id: MAX_LENGTH_ID, content: 'two' },
        ],
      },
    };

    applyOpenAiModelSettings(request);

    const [assistant, firstResult, secondResult] = request.body.messages;
    if (
      assistant.role !== 'assistant' ||
      firstResult.role !== 'tool' ||
      secondResult.role !== 'tool'
    ) {
      throw new Error('unexpected message shape');
    }
    const [firstCall, secondCall] = assistant.tool_calls ?? [];
    expect(firstCall.id).toHaveLength(64);
    expect(firstCall.id).not.toBe(LONG_ID);
    expect(firstResult.tool_call_id).toBe(firstCall.id);
    expect(secondCall.id).toBe(MAX_LENGTH_ID);
    expect(secondResult.tool_call_id).toBe(MAX_LENGTH_ID);
  });

  it('normalizes responses call ids longer than 64 characters consistently', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'openai/gpt-6.1-sol',
        input: [
          { type: 'function_call', call_id: LONG_ID, name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: LONG_ID, output: 'one' },
          { type: 'custom_tool_call', call_id: LONG_ID, name: 'patch', input: '' },
          { type: 'custom_tool_call_output', call_id: LONG_ID, output: 'two' },
          { type: 'function_call', call_id: MAX_LENGTH_ID, name: 'read', arguments: '{}' },
          { type: 'function_call_output', call_id: MAX_LENGTH_ID, output: 'three' },
        ],
      } as GatewayResponsesRequest,
    };

    applyOpenAiModelSettings(request);

    const callIds = (request.body.input as Array<{ call_id: string }>).map(item => item.call_id);
    expect(callIds[0]).toHaveLength(64);
    expect(callIds[0]).not.toBe(LONG_ID);
    expect(callIds.slice(1, 4)).toEqual([callIds[0], callIds[0], callIds[0]]);
    expect(callIds.slice(4)).toEqual([MAX_LENGTH_ID, MAX_LENGTH_ID]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
