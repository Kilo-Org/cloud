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
  assistantFailureMessage,
  classifyAssistantFailureMessage,
  classifyAssistantFailure,
  genericFailureMessage,
  isAssistantInterrupt,
  projectSafeAssistantError,
  projectSafeFailure,
} from './safe-failure-projection.js';

describe('projectSafeAssistantError', () => {
  it.each([
    'Payment required: insufficient credits',
    'Unknown model',
    'Rate limit exceeded',
    'Provider timeout',
    'Provider authentication failed',
    'Invalid request',
    'Service unavailable',
    'Poolside: Tool calls cutoff by max_tokens',
    'Unrecognized failure',
  ])('preserves classification and BYOK semantics through safe projection: %s', text => {
    for (const message of [text, `[BYOK] ${text}`]) {
      for (const error of [message, { name: 'APIError', data: { message } }]) {
        const failure = classifyAssistantFailure(error);
        const safeError = projectSafeAssistantError(error);

        expect(safeError).toBe(
          failure.providerOwnership === 'byok'
            ? `[BYOK] ${failure.safeMessage}`
            : failure.safeMessage
        );
        expect(classifyAssistantFailure(safeError)).toEqual(failure);
        expect(projectSafeAssistantError(safeError)).toBe(safeError);
      }
    }
  });

  it.each(CLOUD_AGENT_ASSISTANT_FAILURE_REASONS)(
    'round-trips canonical %s messages without losing cause or ownership',
    reason => {
      const message = assistantFailureMessage(reason);
      for (const prefix of ['', '[BYOK] ']) {
        const safeError = projectSafeAssistantError(`${prefix}${message}`);

        expect(safeError).toBe(`${prefix}${message}`);
        expect(projectSafeAssistantError(safeError)).toBe(safeError);
        for (const providerOwnership of CLOUD_AGENT_PROVIDER_OWNERSHIPS) {
          expect(classifyAssistantFailure(safeError, providerOwnership)).toMatchObject({
            reason,
            safeMessage: message,
            providerOwnership: prefix ? 'byok' : providerOwnership,
          });
        }
      }
    }
  );

  it.each([
    ['APIError', 503, 'Assistant service is unavailable'],
    ['APIError', undefined, 'Assistant request failed'],
    ['FutureError', 402, 'Assistant request failed'],
    ['ContextOverflowError', 402, 'The model context limit was exceeded'],
  ] as const)('does not inspect or retain private fields from %s', (name, statusCode, expected) => {
    const error = {
      name,
      message: 'outer poison-message',
      data: {
        message: 'Unrecognized failure token=poison-token',
        statusCode,
        responseBody: JSON.stringify({
          error: { message: '[BYOK] insufficient credits', statusCode: 402 },
          prompt: 'poison-prompt',
        }),
        responseHeaders: {
          authorization: 'Bearer poison-header',
          cookie: 'poison-cookie',
          'x-error': 'Unknown model',
        },
        metadata: { message: 'Rate limit exceeded', token: 'poison-metadata' },
      },
    };
    const safeError = projectSafeAssistantError(error);

    expect(safeError).toBe(expected);
    expect(safeError).not.toContain('poison');
    expect(classifyAssistantFailure(safeError).providerOwnership).toBe('unknown');
  });

  it.each([
    [{ name: 'MessageAbortedError', data: { responseBody: 'poison-body' } }, ''],
    ['user-interrupt token=poison-token', ''],
    ['[BYOK] The message was interrupted by the user', '[BYOK] '],
    [
      {
        name: 'MessageAbortedError',
        data: { message: '[BYOK] 401 token=poison-token', responseBody: 'poison-body' },
      },
      '[BYOK] ',
    ],
  ] as const)('preserves interrupt meaning as a safe string: %j', (error, prefix) => {
    const safeError = projectSafeAssistantError(error);

    expect(safeError).toBe(`${prefix}The message was interrupted by the user`);
    expect(isAssistantInterrupt(safeError)).toBe(true);
    expect(classifyAssistantFailureMessage(safeError)).toBe(
      'The message was interrupted by the user'
    );
    expect(projectSafeAssistantError(safeError)).toBe(safeError);
  });

  it.each([null, undefined])('omits absent errors: %s', error => {
    expect(projectSafeAssistantError(error)).toBeUndefined();
  });
});

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

  it('describes no-output failures as a lack of execution progress during the watchdog window', () => {
    expect(projectSafeFailure({ failureCode: 'wrapper_no_output' })?.message).toBe(
      'Agent wrapper made no execution progress during the watchdog window'
    );
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

describe('assistantFailureMessage', () => {
  it.each([
    ['insufficient_credits', 'Assistant request failed: insufficient credits'],
    ['rate_limited', 'Assistant request was rate limited'],
    ['model_unavailable', 'Assistant request failed: model not found'],
    ['provider_authentication', 'Assistant request was not authorized'],
    ['provider_unavailable', 'Assistant service is unavailable'],
    ['timeout', 'Assistant request timed out'],
    ['invalid_request', 'Assistant request was invalid'],
    ['context_limit', 'The model context limit was exceeded'],
    ['output_limit', 'The model output limit was reached'],
    ['content_filter', 'The model provider blocked the response under its content policy'],
    ['structured_output', 'The model response did not match the required format'],
    ['unknown', 'Assistant request failed'],
  ] as const)('returns bounded safe wording for %s', (reason, expected) => {
    expect(assistantFailureMessage(reason)).toBe(expected);
    expect(assistantFailureMessage(reason).length).toBeLessThanOrEqual(
      SAFE_FAILURE_MESSAGE_MAX_LENGTH
    );
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
    [
      'Poolside: Tool calls cutoff by max_tokens token=secret',
      'The model output limit was reached',
    ],
    ['Tool calls cut off by max_tokens: private body', 'The model output limit was reached'],
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
});

describe('classifyAssistantFailure', () => {
  it.each([
    ['ContextOverflowError', 'context_limit', 'The model context limit was exceeded'],
    ['MessageOutputLengthError', 'output_limit', 'The model output limit was reached'],
    [
      'ContentFilterError',
      'content_filter',
      'The model provider blocked the response under its content policy',
    ],
    [
      'StructuredOutputError',
      'structured_output',
      'The model response did not match the required format',
    ],
    ['ProviderAuthError', 'provider_authentication', 'Assistant request was not authorized'],
  ] as const)(
    'retains the precise %s cause through safe projection',
    (name, reason, safeMessage) => {
      expect(classifyAssistantFailure({ name })).toEqual({
        reason,
        safeMessage,
        providerOwnership: 'unknown',
      });

      for (const message of [
        'Unrecognized failure',
        '400 invalid request',
        '503 Service unavailable',
      ]) {
        for (const prefix of ['', '[BYOK] ']) {
          const error = { name, data: { message: `${prefix}${message}`, statusCode: 402 } };
          const failure = classifyAssistantFailure(error);
          const safeError = projectSafeAssistantError(error);

          expect(failure).toEqual({
            reason,
            safeMessage,
            providerOwnership: prefix ? 'byok' : 'unknown',
          });
          expect(safeError).toBe(`${prefix}${safeMessage}`);
          expect(classifyAssistantFailure(safeError)).toEqual(failure);
        }
      }
    }
  );

  it.each([
    [100, 'unknown', undefined],
    [200, 'unknown', undefined],
    [399, 'unknown', undefined],
    [400, 'invalid_request', undefined],
    [401, 'provider_authentication', undefined],
    [402, 'insufficient_credits', 'payment_required'],
    [403, 'provider_authentication', undefined],
    [404, 'invalid_request', undefined],
    [408, 'timeout', undefined],
    [422, 'invalid_request', undefined],
    [429, 'rate_limited', undefined],
    [499, 'invalid_request', undefined],
    [500, 'provider_unavailable', undefined],
    [503, 'provider_unavailable', undefined],
    [504, 'timeout', undefined],
    [599, 'provider_unavailable', undefined],
  ] as const)(
    'uses numeric APIError status %s only when no message cause is known',
    (statusCode, reason, terminalCode) => {
      for (const message of [undefined, 'Unrecognized failure token=poison-token']) {
        const error = { name: 'APIError', data: { statusCode, message } };
        const failure = classifyAssistantFailure(error);
        const safeError = projectSafeAssistantError(error);

        expect(failure).toEqual({
          reason,
          safeMessage: assistantFailureMessage(reason),
          providerOwnership: 'unknown',
          ...(terminalCode === undefined ? {} : { terminalCode }),
        });
        expect(safeError).toBe(assistantFailureMessage(reason));
        expect(classifyAssistantFailure(safeError)).toEqual(failure);
      }
    }
  );

  it.each([undefined, null, true, '402', '503', 99, 600, 503.5, NaN, Infinity, -Infinity, {}, []])(
    'ignores malformed APIError status %s without losing a known message cause',
    statusCode => {
      expect(classifyAssistantFailure({ name: 'APIError', data: { statusCode } })).toEqual({
        reason: 'unknown',
        safeMessage: 'Assistant request failed',
        providerOwnership: 'unknown',
      });
      expect(
        classifyAssistantFailure({
          name: 'APIError',
          data: { statusCode, message: 'Rate limit exceeded' },
        }).reason
      ).toBe('rate_limited');
    }
  );

  it.each([undefined, 'UnknownError', 'FutureError', 'apierror', 402])(
    'does not infer a status cause from unrecognized SDK kind %s',
    name => {
      for (const statusCode of [400, 401, 402, 403, 408, 429, 503, 504]) {
        const error = { name, data: { statusCode } };

        expect(classifyAssistantFailure(error)).toEqual({
          reason: 'unknown',
          safeMessage: 'Assistant request failed',
          providerOwnership: 'unknown',
        });
        expect(projectSafeAssistantError(error)).toBe('Assistant request failed');
      }
    }
  );

  it.each([
    false,
    0,
    '',
    [],
    {},
    { name: 'APIError', data: null },
    { name: 'APIError', data: 402 },
    { name: 'APIError', data: '[BYOK] payment required' },
    { name: 'APIError', data: [{ message: '[BYOK] payment required', statusCode: 402 }] },
    { name: { name: 'ProviderAuthError' }, data: { statusCode: 401 } },
    { name: 'APIError', statusCode: 402, data: { message: 401 } },
  ])('falls back safely for malformed structured errors: %j', error => {
    expect(classifyAssistantFailure(error)).toEqual({
      reason: 'unknown',
      safeMessage: 'Assistant request failed',
      providerOwnership: 'unknown',
    });
    expect(projectSafeAssistantError(error)).toBe('Assistant request failed');
  });

  it.each([null, 402, {}, ['Payment required']])(
    'falls back from non-string SDK message %j to a valid message or status',
    message => {
      const error = { name: 'APIError', data: { message, statusCode: 408 } };

      expect(classifyAssistantFailure(error).reason).toBe('timeout');
      expect(projectSafeAssistantError(error)).toBe('Assistant request timed out');
      expect(classifyAssistantFailure({ ...error, message: 'Unknown model' })).toEqual({
        reason: 'model_unavailable',
        safeMessage: 'Assistant request failed: model not found',
        providerOwnership: 'unknown',
        terminalCode: 'model_missing',
      });
    }
  );

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

  it.each([
    {
      source: '[BYOK] insufficient credits; unknown model; 429 timeout; token=poisoned-secret',
      reason: 'insufficient_credits',
      terminalCode: 'payment_required',
      safeMessage: 'Assistant request failed: insufficient credits',
    },
    {
      source: '[BYOK] unknown model; 429 timeout; token=poisoned-secret',
      reason: 'model_unavailable',
      terminalCode: 'model_missing',
      safeMessage: 'Assistant request failed: model not found',
    },
    {
      source:
        '[BYOK] Poolside: Tool calls cutoff by max_tokens; 429 timeout; token=poisoned-secret',
      reason: 'output_limit',
      safeMessage: 'The model output limit was reached',
    },
    {
      source: '[BYOK] 429 Too Many Requests; timeout; token=poisoned-secret',
      reason: 'rate_limited',
      safeMessage: 'Assistant request was rate limited',
    },
    {
      source: '[BYOK] deadline exceeded; 403 Forbidden; token=poisoned-secret',
      reason: 'timeout',
      safeMessage: 'Assistant request timed out',
    },
    {
      source: '[BYOK] 401 Unauthorized; token=poisoned-secret',
      reason: 'provider_authentication',
      safeMessage: 'Assistant request was not authorized',
    },
  ])(
    'preserves $reason message precedence over SDK kinds and status',
    ({ source, ...expected }) => {
      const errors = [
        source,
        ...[
          'APIError',
          'ContextOverflowError',
          'MessageOutputLengthError',
          'ContentFilterError',
          'StructuredOutputError',
          'ProviderAuthError',
        ].map(name => ({ name, data: { message: source, statusCode: 500 } })),
      ];
      for (const error of errors) {
        const failure = classifyAssistantFailure(error, 'managed');

        expect(failure).toEqual({ ...expected, providerOwnership: 'byok' });
        expect(JSON.stringify(failure)).not.toContain('poisoned-secret');
        expect(classifyAssistantFailure(projectSafeAssistantError(error), 'managed')).toEqual(
          failure
        );
      }
    }
  );

  it.each([
    ['400 invalid request', 503, 'invalid_request'],
    ['503 Service unavailable', 400, 'provider_unavailable'],
  ] as const)(
    'keeps the known message %s ahead of APIError status %s',
    (message, statusCode, reason) => {
      expect(classifyAssistantFailure({ name: 'APIError', data: { message, statusCode } })).toEqual(
        {
          reason,
          safeMessage: assistantFailureMessage(reason),
          providerOwnership: 'unknown',
        }
      );
    }
  );

  it('does not guess ownership for an unmarked provider outage', () => {
    expect(classifyAssistantFailure('503 Service Unavailable')).toMatchObject({
      reason: 'provider_unavailable',
      providerOwnership: 'unknown',
    });
  });
});

describe('isAssistantInterrupt', () => {
  it('recognizes MessageAbortedError and user-interrupt text', () => {
    expect(
      isAssistantInterrupt({ name: 'MessageAbortedError', data: { message: 'aborted' } })
    ).toBe(true);
    expect(isAssistantInterrupt('user-interrupt')).toBe(true);
    expect(isAssistantInterrupt('The message was interrupted by the user')).toBe(true);
    expect(isAssistantInterrupt('provider exploded')).toBe(false);
  });

  it('maps abort errors to the user-interrupt safe message', () => {
    expect(
      classifyAssistantFailureMessage({
        name: 'MessageAbortedError',
        data: { message: 'aborted mid-tool' },
      })
    ).toBe('The message was interrupted by the user');
  });
});
