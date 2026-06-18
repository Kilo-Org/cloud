import type { User } from '@kilocode/db/schema';
import * as z from 'zod';

import { createReviewMemoryGatewayProvider, generateReviewMemoryStructuredOutput } from './llm';

const TestOutputSchema = z.object({
  status: z.literal('ok'),
  value: z.string(),
});

describe('Review Memory structured model output', () => {
  it('sends JSON Schema through the gateway and returns typed output', async () => {
    let requestBody: unknown;
    const gatewayFetch: typeof fetch = async (_request, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: 'gateway-response-id',
          object: 'chat.completion',
          created: 1_750_204_800,
          model: 'test/model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"status":"ok","value":"accepted"}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    };
    const actor = {
      id: 'test-user-id',
      api_token_pepper: null,
    } as User;
    const provider = createReviewMemoryGatewayProvider({
      owner: { type: 'user', id: actor.id },
      actor,
      userAgent: 'Review Memory structured output test',
      fetch: gatewayFetch,
    });

    const result = await generateReviewMemoryStructuredOutput({
      model: provider.chatModel('test/model'),
      prompt: 'Return a test result.',
      maxOutputTokens: 100,
      schemaName: 'test_review_memory_output',
      schema: TestOutputSchema,
      validate: output => output,
    });

    expect(result).toEqual({
      output: { status: 'ok', value: 'accepted' },
      tokensIn: 12,
      tokensOut: 5,
    });
    expect(requestBody).toEqual(
      expect.objectContaining({
        response_format: expect.objectContaining({
          type: 'json_schema',
          json_schema: expect.objectContaining({ strict: true }),
        }),
      })
    );
  });
});
