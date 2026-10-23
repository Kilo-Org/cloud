import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { removePaidServerFeatures } from './remove-paid-server-features';

const MODEL = 'vendor/model:free';
const FREE_PDF_PARSER = { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } };
const functionTool = {
  type: 'function',
  function: { name: 'lookup', parameters: { type: 'object' } },
} as const;

function makeProvider(id: Provider['id'] = 'openrouter'): Provider {
  return {
    id,
    apiUrl: 'https://example.com/v1',
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: 'test-key',
    apiKeyHeader: null,
    supportedChatApis: ['chat_completions', 'responses', 'messages'],
    responseTransforms: null,
    async transformRequest() {},
  };
}

function makeChatRequest(
  fields: Record<string, unknown> = {}
): Extract<GatewayRequest, { kind: 'chat_completions' }> {
  return {
    kind: 'chat_completions',
    body: { model: MODEL, messages: [{ role: 'user', content: 'hello' }], ...fields },
  };
}

describe('removePaidServerFeatures', () => {
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('removes paid plugins and server tools, and logs what it removed', () => {
    const paidPlugins = [{ id: 'web' }, { id: 'file-parser', pdf: { engine: 'mistral-ocr' } }];
    const request = makeChatRequest({
      plugins: [...paidPlugins, { id: 'response-healing' }],
      tools: [{ type: 'openrouter:web_search' }, functionTool, { type: 'openrouter:advisor' }],
    });

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body.plugins).toEqual([{ id: 'response-healing' }, FREE_PDF_PARSER]);
    expect(request.body.tools).toEqual([functionTool]);
    expect(warn).toHaveBeenCalledWith(
      '[applyProviderSpecificLogic] Removed paid server features from free request',
      {
        userId: 'user-1',
        model: MODEL,
        requestKind: 'chat_completions',
        removedPlugins: paidPlugins,
        removedToolTypes: ['openrouter:web_search', 'openrouter:advisor'],
      }
    );
  });

  it('keeps free plugins, including a disabled one, without logging', () => {
    const freePlugins = [{ id: 'response-healing' }, { id: 'context-compression', enabled: false }];
    const request = makeChatRequest({ plugins: freePlugins });

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body.plugins).toEqual([...freePlugins, FREE_PDF_PARSER]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('adds no PDF parser for providers other than OpenRouter', () => {
    const request = makeChatRequest({ plugins: [{ id: 'web' }] });

    removePaidServerFeatures(makeProvider('vercel'), MODEL, request, 'user-1');

    expect(request.body).not.toHaveProperty('plugins');
  });

  it('removes the tool list and tool choice when only server tools were requested', () => {
    const request = makeChatRequest({
      tools: [{ type: 'openrouter:web_search' }],
      tool_choice: 'required',
    });

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body).not.toHaveProperty('tools');
    expect(request.body).not.toHaveProperty('tool_choice');
  });

  it('removes a tool choice that forces a removed server tool', () => {
    const lookupTool = {
      type: 'function',
      name: 'lookup',
      parameters: null,
      strict: false,
    } as const;
    const request: Extract<GatewayRequest, { kind: 'responses' }> = {
      kind: 'responses',
      body: {
        model: MODEL,
        input: 'hello',
        tools: [{ type: 'web_search_preview' }, lookupTool],
        tool_choice: { type: 'web_search_preview' },
      },
    };

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body.tools).toEqual([lookupTool]);
    expect(request.body).not.toHaveProperty('tool_choice');
  });

  it('keeps client-executed Messages API tools', () => {
    const customTool = { name: 'lookup', input_schema: { type: 'object' as const } };
    const request: Extract<GatewayRequest, { kind: 'messages' }> = {
      kind: 'messages',
      body: {
        model: MODEL,
        max_tokens: 2_048,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          customTool,
          { type: 'custom', ...customTool },
          { type: 'web_search_20250305', name: 'web_search' },
        ],
        tool_choice: { type: 'tool', name: 'lookup' },
      },
    };

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body.tools).toEqual([customTool, { type: 'custom', ...customTool }]);
    expect(request.body.tool_choice).toEqual({ type: 'tool', name: 'lookup' });
  });

  it('does not log when there is nothing to remove', () => {
    const request = makeChatRequest({ tools: [functionTool] });

    removePaidServerFeatures(makeProvider(), MODEL, request, 'user-1');

    expect(request.body.tools).toEqual([functionTool]);
    expect(request.body.plugins).toEqual([FREE_PDF_PARSER]);
    expect(warn).not.toHaveBeenCalled();
  });
});
