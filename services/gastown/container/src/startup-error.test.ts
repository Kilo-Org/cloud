import { describe, expect, it } from 'vitest';
import { AgentStartupError, classifyStartupError } from './startup-error';

describe('classifyStartupError', () => {
  it('classifies initial prompt rate-limit gateway failures', () => {
    const payload = classifyStartupError(
      {
        status: 429,
        body: {
          error: 'Free model rate limit exceeded',
          error_type: 'rate_limit_exceeded',
        },
      },
      'initial_prompt'
    );

    expect(payload).toEqual({
      error: 'Free model rate limit exceeded',
      phase: 'initial_prompt',
      status: 429,
      error_type: 'rate_limit_exceeded',
      action: 'Wait and retry, or switch the town/rig to a model with available quota.',
    });
  });

  it('extracts gateway details embedded in SDK error messages', () => {
    const payload = classifyStartupError(
      new Error(
        'Request failed: {"error":{"message":"quota exhausted"},"error_type":"rate_limit_exceeded"}'
      ),
      'initial_prompt'
    );

    expect(payload).toEqual({
      error: 'quota exhausted',
      phase: 'initial_prompt',
      error_type: 'rate_limit_exceeded',
    });
  });

  it('preserves already-classified startup payloads', () => {
    const error = new AgentStartupError({
      error: 'classified failure',
      phase: 'initial_prompt',
      status: 500,
      error_type: 'server_error',
    });

    expect(classifyStartupError(error)).toEqual({
      error: 'classified failure',
      phase: 'initial_prompt',
      status: 500,
      error_type: 'server_error',
    });
  });
});
