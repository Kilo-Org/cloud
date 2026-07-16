import type { User } from '@kilocode/db/schema';

import { createReviewMemoryGatewayProvider, generateReviewMemoryStructuredOutput } from './llm';
import {
  MAX_INTEGRATION_SUMMARY_CHARS,
  ReviewMdIntegrationOutputSchema,
  validateReviewMdIntegrationOutput,
} from './review-md-integration';

describe('validateReviewMdIntegrationOutput', () => {
  it('clamps an over-length integrationSummary instead of throwing', () => {
    const result = validateReviewMdIntegrationOutput({
      status: 'updated',
      updatedReviewMd: '# Guide\n- always lint',
      integrationSummary: 'x'.repeat(MAX_INTEGRATION_SUMMARY_CHARS + 500),
    });

    expect(result.integrationSummary).toHaveLength(MAX_INTEGRATION_SUMMARY_CHARS);
    expect(result.updatedReviewMd).toBe('# Guide\n- always lint');
  });

  it('falls back to a default summary when the model returns an empty one', () => {
    const result = validateReviewMdIntegrationOutput({
      status: 'already_present',
      updatedReviewMd: null,
      integrationSummary: '   ',
    });

    expect(result.integrationSummary).toBe('Updated REVIEW.md guidance.');
    expect(result.status).toBe('already_present');
  });

  it('throws when status is updated but updatedReviewMd is missing', () => {
    expect(() =>
      validateReviewMdIntegrationOutput({
        status: 'updated',
        updatedReviewMd: null,
        integrationSummary: 'ok',
      })
    ).toThrow(/without updatedReviewMd/);
  });

  it('throws when updatedReviewMd exceeds the size ceiling', () => {
    expect(() =>
      validateReviewMdIntegrationOutput({
        status: 'updated',
        updatedReviewMd: 'a'.repeat(30_001),
        integrationSummary: 'ok',
      })
    ).toThrow(/exceeds 30000 characters/);
  });

  it('throws when the integrated file mentions Review Memory', () => {
    expect(() =>
      validateReviewMdIntegrationOutput({
        status: 'updated',
        updatedReviewMd: '# Review Memory\n- do things',
        integrationSummary: 'ok',
      })
    ).toThrow(/must not mention Review Memory/);
  });
});

describe('Review Memory integration structured output', () => {
  // Regression for the plug-and-pay failure: the wire schema strips maxLength, so a
  // complete response whose integrationSummary runs past the source cap used to throw
  // "No object generated: response did not match schema". It must now succeed (clamped).
  it('accepts a complete response with an over-length summary', async () => {
    const longSummary = 'y'.repeat(MAX_INTEGRATION_SUMMARY_CHARS + 400);
    const gatewayFetch: typeof fetch = async () =>
      new Response(
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
                content: JSON.stringify({
                  status: 'updated',
                  updatedReviewMd: '# Guide\n- fail CI on lint errors',
                  integrationSummary: longSummary,
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    const actor = { id: 'test-user-id', api_token_pepper: null } as User;
    const provider = createReviewMemoryGatewayProvider({
      owner: { type: 'user', id: actor.id },
      actor,
      userAgent: 'Review Memory integration test',
      fetch: gatewayFetch,
    });

    const result = await generateReviewMemoryStructuredOutput({
      model: provider.chatModel('test/model'),
      prompt: 'Integrate the proposal.',
      maxOutputTokens: 8_000,
      schemaName: 'review_md_integration',
      schema: ReviewMdIntegrationOutputSchema,
      validate: validateReviewMdIntegrationOutput,
    });

    expect(result.output.status).toBe('updated');
    expect(result.output.updatedReviewMd).toBe('# Guide\n- fail CI on lint errors');
    expect(result.output.integrationSummary).toHaveLength(MAX_INTEGRATION_SUMMARY_CHARS);
  });
});
