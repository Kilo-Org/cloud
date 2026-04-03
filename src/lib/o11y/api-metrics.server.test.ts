import { describe, expect, it } from '@jest/globals';
import { getToolsAvailable, getToolsUsed } from '@/lib/o11y/api-metrics.server';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

describe('api metrics tool extraction', () => {
  it('returns empty toolsAvailable when chat completions tools is a non-array object', () => {
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'x-ai/grok-4.1-fast',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: { todowrite: false, task: false },
      },
    } as unknown as GatewayRequest;

    expect(getToolsAvailable(request)).toEqual([]);
  });

  it('extracts chat completions tools when tools is an array', () => {
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'x-ai/grok-4.1-fast',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          { type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { type: 'custom', custom: { name: 'run_sql' } },
        ],
      },
    } as unknown as GatewayRequest;

    expect(getToolsAvailable(request)).toEqual(['function:read_file', 'custom:run_sql']);
  });

  it('returns empty toolsUsed when chat completions has no assistant tool calls', () => {
    const request = {
      kind: 'chat_completions',
      body: {
        model: 'x-ai/grok-4.1-fast',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    } as unknown as GatewayRequest;

    expect(getToolsUsed(request)).toEqual([]);
  });
});
