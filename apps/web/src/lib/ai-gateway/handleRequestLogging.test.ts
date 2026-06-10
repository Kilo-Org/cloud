import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { shouldLogGlmVisitedUrlsRequest } from './handleRequestLogging';

const visitedUrlsTool = {
  type: 'function' as const,
  function: {
    name: 'search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          properties: {
            visitedUrls: {
              type: 'array',
              items: {
                $ref: '#/properties/filters/properties/visitedUrls/items',
              },
            },
          },
        },
      },
    },
  },
};

function chatRequest(tools: GatewayRequest['body']['tools']): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'z-ai/glm-5.1',
      messages: [{ role: 'user', content: 'Search' }],
      tools,
    },
  };
}

describe('shouldLogGlmVisitedUrlsRequest', () => {
  it('enables logging for individual GLM requests with the visited URLs item reference', () => {
    expect(
      shouldLogGlmVisitedUrlsRequest(chatRequest([visitedUrlsTool]), 'z-ai/glm-5.1', null)
    ).toBe(true);
  });

  it.each([
    ['organization request', 'z-ai/glm-5.1', 'organization-id', [visitedUrlsTool]],
    ['non-GLM request', 'anthropic/claude-sonnet-4', null, [visitedUrlsTool]],
    [
      'request without the reference',
      'z-ai/glm-5.1',
      null,
      [
        {
          ...visitedUrlsTool,
          function: {
            ...visitedUrlsTool.function,
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    ],
  ])('does not enable logging for a %s', (_name, model, organizationId, tools) => {
    expect(shouldLogGlmVisitedUrlsRequest(chatRequest(tools), model, organizationId)).toBe(false);
  });
});
