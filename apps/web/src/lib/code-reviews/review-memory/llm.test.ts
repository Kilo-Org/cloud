import type { User } from '@kilocode/db/schema';
import { MockLanguageModelV3 } from 'ai/test';
import * as z from 'zod';

import {
  ReviewMemoryProposalDraftSchema,
  ReviewMemoryProposalWireSchema,
  validateReviewMemoryProposalDraft,
} from './aggregation';
import {
  createReviewMemoryGatewayProvider,
  generateReviewMemoryStructuredOutput,
  ReviewMemoryModelBoundaryError,
} from './llm';
import {
  ReviewMdIntegrationOutputSchema,
  validateReviewMdIntegrationOutput,
} from './review-md-integration';

const TestOutputSchema = z.object({
  status: z.literal('ok'),
  value: z.string(),
});

const RAW_OUTPUT_SENTINEL = 'RAW_GENERATED_OUTPUT_SECRET';
const PROMPT_SENTINEL = 'PROMPT_CONTENT_SECRET';

function buildModel(input: {
  text: string;
  finishReason?: {
    unified: 'stop' | 'length';
    raw: string;
  };
  responseId?: string;
  providerRequestId?: string;
}) {
  return new MockLanguageModelV3({
    provider: 'test-provider',
    modelId: 'test-model',
    doGenerate: {
      content: [{ type: 'text', text: input.text }],
      finishReason: input.finishReason ?? { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 12,
          noCache: 12,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 5,
          text: 5,
          reasoning: 0,
        },
      },
      response: {
        id: input.responseId ?? 'response-123',
        timestamp: new Date('2026-06-18T00:00:00.000Z'),
        modelId: 'test-model',
        headers: {
          'request-id': input.providerRequestId ?? 'provider-request-123',
        },
      },
      warnings: [],
    },
  });
}

function generateWithModel(model: MockLanguageModelV3, log: (record: string) => void = () => {}) {
  return generateReviewMemoryStructuredOutput({
    model,
    modelSlug: 'test/model',
    operation: 'proposal_analysis',
    requestCorrelationId: 'request-correlation-123',
    prompt: `Analyze without recording ${PROMPT_SENTINEL}`,
    maxOutputTokens: 100,
    schemaName: 'test_review_memory_output',
    schema: TestOutputSchema,
    validate: output => output,
    log,
  });
}

describe('Review Memory structured model output', () => {
  it('returns typed JSON output with token and provider metadata', async () => {
    const model = buildModel({ text: '{"status":"ok","value":"accepted"}' });
    const records: string[] = [];

    const result = await generateWithModel(model, record => records.push(record));

    expect(result.output).toEqual({ status: 'ok', value: 'accepted' });
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        outcome: 'success',
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        responseId: 'response-123',
        providerRequestId: 'provider-request-123',
      })
    );
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.responseFormat).toEqual(
      expect.objectContaining({
        type: 'json',
        schema: expect.any(Object),
      })
    );
    expect(records).toHaveLength(1);
  });

  it('transmits a provider-compatible proposal schema while validating the source Zod schema', async () => {
    const model = buildModel({
      text: JSON.stringify({
        status: 'propose',
        title: 'Generated fixtures',
        rationale: 'Maintainers repeatedly corrected generated fixture comments.',
        proposedMarkdown: 'Ignore generated fixtures unless their source behavior changes.',
        positiveCount: 0,
        negativeCount: 2,
        neutralCount: 0,
        evidenceEventIds: [],
      }),
    });

    await generateReviewMemoryStructuredOutput({
      model,
      modelSlug: 'test/model',
      operation: 'proposal_analysis',
      requestCorrelationId: 'request-proposal-schema',
      prompt: 'Analyze feedback.',
      maxOutputTokens: 100,
      schemaName: 'review_memory_proposal',
      schema: ReviewMemoryProposalDraftSchema,
      wireSchema: ReviewMemoryProposalWireSchema,
      validate: validateReviewMemoryProposalDraft,
      log: () => {},
    });

    const responseFormat = model.doGenerateCalls[0]?.responseFormat;
    expect(responseFormat).toEqual(
      expect.objectContaining({
        type: 'json',
        schema: expect.objectContaining({ type: 'object' }),
      })
    );
    const serializedResponseFormat = JSON.stringify(responseFormat);
    expect(serializedResponseFormat).not.toContain('"oneOf"');
    expect(serializedResponseFormat).not.toMatch(
      /"(?:minimum|maximum|minLength|maxLength|maxItems|uniqueItems)"/
    );
  });

  it('transmits a provider-compatible REVIEW.md integration schema', async () => {
    const model = buildModel({
      text: JSON.stringify({
        status: 'updated',
        updatedReviewMd: '# Code review\n\nCheck generated fixtures against their source.',
        integrationSummary: 'Added generated fixture guidance.',
      }),
    });

    await generateReviewMemoryStructuredOutput({
      model,
      modelSlug: 'test/model',
      operation: 'review_md_integration',
      requestCorrelationId: 'request-integration-schema',
      prompt: 'Integrate guidance.',
      maxOutputTokens: 100,
      schemaName: 'review_md_integration',
      schema: ReviewMdIntegrationOutputSchema,
      validate: validateReviewMdIntegrationOutput,
      log: () => {},
    });

    const responseFormat = JSON.stringify(model.doGenerateCalls[0]?.responseFormat);
    expect(responseFormat).toContain('"type":"json"');
    expect(responseFormat).not.toMatch(/"(?:minLength|maxLength)"/);
  });

  it('sends JSON Schema and requires compatible gateway routing', async () => {
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
          headers: {
            'content-type': 'application/json',
            'request-id': 'gateway-request-id',
          },
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
    const model = provider.chatModel('test/model');

    await generateReviewMemoryStructuredOutput({
      model,
      modelSlug: 'test/model',
      operation: 'proposal_analysis',
      requestCorrelationId: 'request-wire-format',
      prompt: 'Return a test result.',
      maxOutputTokens: 100,
      schemaName: 'test_review_memory_output',
      schema: TestOutputSchema,
      validate: output => output,
      log: () => {},
    });

    expect(Reflect.get(model, 'supportsStructuredOutputs')).toBe(true);
    expect(requestBody).toEqual(
      expect.objectContaining({
        response_format: expect.objectContaining({
          type: 'json_schema',
          json_schema: expect.objectContaining({ strict: true }),
        }),
      })
    );
    expect(requestBody).not.toEqual(expect.objectContaining({ provider: expect.anything() }));
  });

  it.each([
    ['fenced JSON', `\`\`\`json\n{"status":"ok","value":"${RAW_OUTPUT_SENTINEL}"}\n\`\`\``],
    ['prose-wrapped JSON', `Result: {"status":"ok","value":"${RAW_OUTPUT_SENTINEL}"}`],
    ['malformed JSON', `{"status":"ok","value":"${RAW_OUTPUT_SENTINEL}`],
    ['schema-invalid JSON', `{"status":"wrong","value":"${RAW_OUTPUT_SENTINEL}"}`],
  ])('rejects %s without recovering text', async (_name, text) => {
    const records: string[] = [];
    const model = buildModel({ text });

    const error = await captureError(() =>
      generateWithModel(model, record => records.push(record))
    );

    expect(error).toBeInstanceOf(ReviewMemoryModelBoundaryError);
    if (!(error instanceof ReviewMemoryModelBoundaryError)) return;
    expect(error.diagnostics).toEqual(
      expect.objectContaining({
        stage: 'structured_output_validation',
        outcome: 'failure',
        failureClassification: 'invalid_structured_output',
      })
    );
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify({
      message: error.message,
      diagnostics: error.diagnostics,
      records,
    });
    expect(serialized).not.toContain(RAW_OUTPUT_SENTINEL);
    expect(serialized).not.toContain(PROMPT_SENTINEL);
  });

  it('sanitizes gateway-generation failures without retaining provider content', async () => {
    const records: string[] = [];
    const model = new MockLanguageModelV3({
      provider: 'test-provider',
      modelId: 'test-model',
      doGenerate: async () => {
        throw new Error(
          `Provider failed at https://provider.example/path?token=secret with ${RAW_OUTPUT_SENTINEL}`
        );
      },
    });

    const error = await captureError(() =>
      generateWithModel(model, record => records.push(record))
    );

    expect(error).toBeInstanceOf(ReviewMemoryModelBoundaryError);
    if (!(error instanceof ReviewMemoryModelBoundaryError)) return;
    expect(error.diagnostics).toEqual(
      expect.objectContaining({
        stage: 'gateway_generation',
        failureClassification: 'generation_failed',
        errorMessage: 'Review Memory model generation failed.',
      })
    );
    const serialized = JSON.stringify({
      message: error.message,
      diagnostics: error.diagnostics,
      records,
    });
    expect(serialized).not.toContain(RAW_OUTPUT_SENTINEL);
    expect(serialized).not.toContain('provider.example');
    expect(serialized).not.toContain(PROMPT_SENTINEL);
  });

  it('classifies length-limited output as incomplete before output access', async () => {
    const records: string[] = [];
    const model = buildModel({
      text: `{"status":"ok","value":"${RAW_OUTPUT_SENTINEL}`,
      finishReason: { unified: 'length', raw: 'max_tokens' },
      responseId: 'length-response-id',
      providerRequestId: 'length-provider-request-id',
    });

    const error = await captureError(() =>
      generateWithModel(model, record => records.push(record))
    );

    expect(error).toBeInstanceOf(ReviewMemoryModelBoundaryError);
    if (!(error instanceof ReviewMemoryModelBoundaryError)) return;
    expect(error.diagnostics).toEqual(
      expect.objectContaining({
        failureClassification: 'incomplete_output',
        finishReason: 'length',
        rawFinishReason: 'max_tokens',
        generatedTextCharacterCount: expect.any(Number),
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        responseId: 'length-response-id',
        providerRequestId: 'length-provider-request-id',
      })
    );
    expect(records).toHaveLength(1);
    const record = JSON.parse(records[0]);
    expect(record).toEqual(
      expect.objectContaining({
        event: 'review_memory_model_generation',
        operation: 'proposal_analysis',
        stage: 'structured_output_validation',
        outcome: 'failure',
        model_slug: 'test/model',
        finish_reason: 'length',
        raw_finish_reason: 'max_tokens',
        provider_request_id: 'length-provider-request-id',
        response_id: 'length-response-id',
      })
    );
    expect(records[0]).not.toContain(RAW_OUTPUT_SENTINEL);
    expect(records[0]).not.toContain(PROMPT_SENTINEL);
  });

  it('does not include generated values from semantic validation errors', async () => {
    const records: string[] = [];
    const model = buildModel({
      text: `{"status":"ok","value":"${RAW_OUTPUT_SENTINEL}"}`,
    });

    const error = await captureError(() =>
      generateReviewMemoryStructuredOutput({
        model,
        modelSlug: 'test/model',
        operation: 'review_md_integration',
        requestCorrelationId: 'request-correlation-semantic',
        prompt: PROMPT_SENTINEL,
        maxOutputTokens: 100,
        schemaName: 'test_semantic_output',
        schema: TestOutputSchema,
        validate: output => {
          throw new Error(`Rejected generated value: ${output.value}`);
        },
        log: record => records.push(record),
      })
    );

    expect(error).toBeInstanceOf(ReviewMemoryModelBoundaryError);
    if (!(error instanceof ReviewMemoryModelBoundaryError)) return;
    expect(error.diagnostics.failureClassification).toBe('invalid_semantic_output');
    const serialized = JSON.stringify({
      message: error.message,
      diagnostics: error.diagnostics,
      records,
    });
    expect(serialized).not.toContain(RAW_OUTPUT_SENTINEL);
    expect(serialized).not.toContain(PROMPT_SENTINEL);
  });
});

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}
