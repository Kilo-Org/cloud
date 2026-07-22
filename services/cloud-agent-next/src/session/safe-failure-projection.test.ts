import {
  CLOUD_AGENT_ASSISTANT_FAILURE_REASONS,
  CLOUD_AGENT_FAILURE_CODES,
  CLOUD_AGENT_PROVIDER_OWNERSHIPS,
  CloudAgentSafeFailureSchema,
} from '@kilocode/worker-utils/cloud-agent-failure';
import { describe, expect, it } from 'vitest';
import {
  SAFE_FAILURE_MESSAGE_MAX_LENGTH,
  SafeFailureProjectionSchema,
  classifyAssistantFailureMessage,
  classifyAssistantFailure,
  genericFailureMessage,
  projectSafeFailure,
} from './safe-failure-projection.js';

describe('projectSafeFailure', () => {
  it('projects structured fields while omitting raw failure text', () => {
    const durableState = {
      failureStage: 'agent_activity' as const,
      failureCode: 'assistant_error' as const,
      attempts: 2,
      error: 'Bearer secret-token',
      failureReason: 'provider body with secret-token',
    };

    expect(projectSafeFailure(durableState)).toStrictEqual({
      stage: 'agent_activity',
      code: 'assistant_error',
      attempts: 2,
      message: 'Assistant request failed',
    });
  });

  it('forwards the assistant reason and provider ownership', () => {
    expect(
      projectSafeFailure({
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        safeFailureMessage: 'Assistant request was rate limited',
        assistantFailureReason: 'rate_limited',
        providerOwnership: 'byok',
      })
    ).toStrictEqual({
      stage: 'agent_activity',
      code: 'assistant_error',
      message: 'Assistant request was rate limited',
      assistantReason: 'rate_limited',
      providerOwnership: 'byok',
    });
  });

  it('omits the new fields when the source has neither', () => {
    const failure = projectSafeFailure({
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
    });

    expect(failure).not.toHaveProperty('assistantReason');
    expect(failure).not.toHaveProperty('providerOwnership');
  });

  it('projects a failure carrying only the assistant classification', () => {
    expect(
      projectSafeFailure({ assistantFailureReason: 'rate_limited', providerOwnership: 'managed' })
    ).toStrictEqual({ assistantReason: 'rate_limited', providerOwnership: 'managed' });
  });

  // The producer contract is .strict() and the callback wrapper turns any parse
  // failure into undefined, discarding the entire failure object. Every shape
  // the projection can emit must survive that parse.
  it.each(CLOUD_AGENT_ASSISTANT_FAILURE_REASONS)(
    'emits a payload the strict contract accepts for reason %s',
    assistantFailureReason => {
      for (const providerOwnership of CLOUD_AGENT_PROVIDER_OWNERSHIPS) {
        const failure = projectSafeFailure({
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          assistantFailureReason,
          providerOwnership,
        });

        expect(CloudAgentSafeFailureSchema.safeParse(failure).success).toBe(true);
      }
    }
  );

  it.each(CLOUD_AGENT_FAILURE_CODES)('always derives a bounded message for %s', failureCode => {
    const failure = projectSafeFailure({ failureCode });

    expect(failure?.message).toBe(genericFailureMessage(failureCode));
    expect(failure?.message?.length).toBeLessThanOrEqual(SAFE_FAILURE_MESSAGE_MAX_LENGTH);
    expect(SafeFailureProjectionSchema.parse(failure)).toEqual(failure);
  });

  it.each([
    ['git_clone_timeout', 'Repository clone timed out'],
    ['git_authentication_failed', 'Repository authentication failed'],
    ['setup_command_failed', 'Setup command failed'],
    ['workspace_setup_unknown', 'Workspace setup failed'],
  ] as const)('derives an allowlisted message for %s', (failureSubtype, message) => {
    expect(projectSafeFailure({ failureCode: 'workspace_setup_failed', failureSubtype })).toEqual({
      code: 'workspace_setup_failed',
      subtype: failureSubtype,
      message,
    });
  });

  it('includes bounded safe detail without duplicating the generic message', () => {
    expect(
      projectSafeFailure({
        failureCode: 'workspace_setup_failed',
        failureSubtype: 'setup_command_failed',
        safeFailureMessage: 'Setup command failed (exit code 2)',
      })
    ).toEqual({
      code: 'workspace_setup_failed',
      subtype: 'setup_command_failed',
      message: 'Setup command failed (exit code 2)',
    });
  });

  it('combines distinct safe detail with the generic message within the public bound', () => {
    const failure = projectSafeFailure({
      failureCode: 'workspace_setup_failed',
      failureSubtype: 'git_clone_timeout',
      safeFailureMessage: `Safe diagnostic ${'x'.repeat(SAFE_FAILURE_MESSAGE_MAX_LENGTH)}`,
    });

    expect(failure?.message).toMatch(/^Repository clone timed out: Safe diagnostic /);
    expect(failure?.message?.length).toBeLessThanOrEqual(SAFE_FAILURE_MESSAGE_MAX_LENGTH);
    expect(SafeFailureProjectionSchema.parse(failure)).toEqual(failure);
  });

  it('uses an explicitly supplied bounded safe message for non-workspace failures', () => {
    expect(
      projectSafeFailure({
        failureCode: 'assistant_error',
        safeFailureMessage: `Assistant request timed out${'x'.repeat(SAFE_FAILURE_MESSAGE_MAX_LENGTH)}`,
      })
    ).toEqual({
      code: 'assistant_error',
      message: `Assistant request timed out${'x'.repeat(
        SAFE_FAILURE_MESSAGE_MAX_LENGTH - 'Assistant request timed out'.length
      )}`,
    });
  });

  it('rejects invalid subtype, attempts, message bounds, and unknown fields', () => {
    expect(() => SafeFailureProjectionSchema.parse({ subtype: 'not_allowlisted' })).toThrow();
    expect(() => SafeFailureProjectionSchema.parse({ attempts: -1 })).toThrow();
    expect(() =>
      SafeFailureProjectionSchema.parse({
        message: 'x'.repeat(SAFE_FAILURE_MESSAGE_MAX_LENGTH + 1),
      })
    ).toThrow();
    expect(() => SafeFailureProjectionSchema.parse({ error: 'raw secret' })).toThrow();
  });
});

describe('classifyAssistantFailureMessage', () => {
  it.each([
    ['Payment Required: token=secret', 'Assistant request failed: insufficient credits'],
    ['usage_limit_exceeded for account secret', 'Assistant request was rate limited'],
    ['Model not found: private/provider-model', 'Assistant request failed: model not found'],
    ['429 Too Many Requests: provider body', 'Assistant request was rate limited'],
    ['upstream request timed out: private body', 'Assistant request timed out'],
    ['403 Forbidden: private policy', 'Assistant request was not authorized'],
    ['400 invalid request: prompt secret', 'Assistant request was invalid'],
    ['503 Service Unavailable: internal host', 'Assistant service is unavailable'],
    ['provider exploded with token=secret', 'Assistant request failed'],
  ])('maps raw assistant text to allowlisted wording', (source, expected) => {
    const result = classifyAssistantFailureMessage(source);

    expect(result).toBe(expected);
    expect(result).not.toContain('secret');
    expect(result).not.toContain('private');
  });

  it('classifies nested provider errors without returning their source text', () => {
    expect(
      classifyAssistantFailureMessage({
        data: { message: 'deadline exceeded: Bearer private-provider-token' },
      })
    ).toBe('Assistant request timed out');
  });

  it.each([
    [
      'Payment Required: {"error":{"message":"Insufficient credits","balance":-0.01,"url":"https://gateway.test/private"}}',
      'payment_required',
      'Assistant request failed: insufficient credits',
    ],
    [
      'Account balance is -$0.25 for tenant secret',
      'payment_required',
      'Assistant request failed: insufficient credits',
    ],
    ['load balance is -1 for shard secret', undefined, 'Assistant request failed'],
    [
      'model_not_found: provider/private-model',
      'model_missing',
      'Assistant request failed: model not found',
    ],
    ['429 Too Many Requests', undefined, 'Assistant request was rate limited'],
    ['upstream timeout', undefined, 'Assistant request timed out'],
    ['403 Forbidden', undefined, 'Assistant request was not authorized'],
    ['400 malformed request', undefined, 'Assistant request was invalid'],
    ['504 upstream unavailable', undefined, 'Assistant service is unavailable'],
    ['unknown provider failure', undefined, 'Assistant request failed'],
  ] as const)(
    'returns a structured terminal classification for %s',
    (source, terminalCode, safeMessage) => {
      const result = classifyAssistantFailure(source);

      expect(result.safeMessage).toBe(safeMessage);
      expect(result.terminalCode).toBe(terminalCode);
    }
  );
});

describe('classifyAssistantFailure', () => {
  it('retains safe structured reason and explicit BYOK ownership without source text', () => {
    expect(classifyAssistantFailure('[BYOK] 401 token=secret')).toEqual({
      reason: 'provider_authentication',
      safeMessage: 'Assistant request was not authorized',
      providerOwnership: 'byok',
    });
  });

  it('returns explicit terminal codes for balance and model failures', () => {
    expect(classifyAssistantFailure('402 payment required')).toMatchObject({
      reason: 'insufficient_credits',
      terminalCode: 'payment_required',
    });
    expect(classifyAssistantFailure('unknown model')).toMatchObject({
      reason: 'model_unavailable',
      terminalCode: 'model_missing',
    });
  });

  it('does not guess ownership for an unmarked provider outage', () => {
    expect(classifyAssistantFailure('503 Service Unavailable')).toMatchObject({
      reason: 'provider_unavailable',
      providerOwnership: 'unknown',
    });
  });
});
