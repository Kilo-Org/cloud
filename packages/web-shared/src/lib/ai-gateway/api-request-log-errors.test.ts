import { describe, expect, test } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { detectToolCallArgumentErrors } from './api-request-log-errors';

const geminiRequest: GatewayRequest = {
  kind: 'generate_content',
  body: {
    model: 'gemini-4-argon',
    stream: true,
    contents: [{ role: 'user', parts: [{ text: 'read a' }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'read',
            parametersJsonSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
    ],
  },
};

function geminiStream(...functionCalls: { id?: string; name: string; args?: unknown }[]) {
  return functionCalls
    .map(
      functionCall =>
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall }] } }] })}\r\n\r\n`
    )
    .join('');
}

describe('detectToolCallArgumentErrors for the Gemini API', () => {
  test('accepts function calls that match their declaration', () => {
    expect(
      detectToolCallArgumentErrors(
        geminiStream({ id: 'call-1', name: 'read', args: { path: 'a' } }),
        geminiRequest
      )
    ).toBeNull();
  });

  test('reports unknown tools and arguments that do not match the declared schema', () => {
    expect(
      detectToolCallArgumentErrors(
        geminiStream({ id: 'call-1', name: 'write', args: {} }, { name: 'read', args: {} }),
        geminiRequest
      )
    ).toEqual({
      invalid_tool_call_arguments: [
        { tool_call_id: 'call-1', tool_name: 'write', kind: 'unknown_tool' },
        {
          tool_call_id: '',
          tool_name: 'read',
          kind: 'schema_mismatch',
          details: expect.anything(),
        },
      ],
    });
  });
});
