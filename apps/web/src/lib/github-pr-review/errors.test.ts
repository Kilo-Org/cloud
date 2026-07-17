import { classifyGitHubHttpError, classifyGitHubGraphQlErrors } from './errors';

function httpError(
  status: number,
  message: string,
  headers?: Record<string, string>
): Error & {
  status: number;
  response?: { headers?: Record<string, string> };
} {
  const err = new Error(message) as Error & {
    status: number;
    response?: { headers?: Record<string, string> };
  };
  err.status = status;
  if (headers) {
    err.response = { headers };
  }
  return err;
}

describe('classifyGitHubHttpError', () => {
  it('maps 404 to NOT_FOUND with the documented message', () => {
    const result = classifyGitHubHttpError(httpError(404, 'Not Found'));
    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toBe(
      "PR not found, you don't have access, or the Kilo GitHub App isn't installed for this repository"
    );
  });

  it('maps 401 to PRECONDITION_FAILED with the reconnect message', () => {
    const result = classifyGitHubHttpError(httpError(401, 'Bad credentials'));
    expect(result.code).toBe('PRECONDITION_FAILED');
    expect(result.message).toBe('GitHub connection is no longer valid — reconnect');
  });

  const NOW = 1_700_000_000_000;

  it('maps 403 with x-ratelimit-remaining:0 to TOO_MANY_REQUESTS with an absolute reset epoch', () => {
    const resetSeconds = Math.floor(NOW / 1000) + 600;
    const result = classifyGitHubHttpError(
      httpError(403, 'API rate limit exceeded', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetSeconds),
      }),
      NOW
    );
    expect(result.code).toBe('TOO_MANY_REQUESTS');
    // Absolute epoch (ms), not a relative delay.
    expect(result.retryAfterEpochMs).toBe(resetSeconds * 1000);
    expect(result.message).toMatch(/Try again in about 10 minutes/);
  });

  it('maps 403 retry-after (delta seconds) to an absolute epoch relative to now', () => {
    const result = classifyGitHubHttpError(
      httpError(403, 'Secondary rate limit', { 'retry-after': '120' }),
      NOW
    );
    expect(result.code).toBe('TOO_MANY_REQUESTS');
    expect(result.retryAfterEpochMs).toBe(NOW + 120_000);
  });

  it('maps 429 to TOO_MANY_REQUESTS regardless of headers', () => {
    const result = classifyGitHubHttpError(httpError(429, 'Too Many Requests'));
    expect(result.code).toBe('TOO_MANY_REQUESTS');
  });

  it('maps non-rate-limit 403 to FORBIDDEN preserving GitHub message', () => {
    const result = classifyGitHubHttpError(
      httpError(403, 'Resource not accessible by integration')
    );
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).toBe('Resource not accessible by integration');
  });

  it('maps 422 stale line comment shape to BAD_REQUEST', () => {
    const result = classifyGitHubHttpError(
      httpError(422, 'Validation Failed: "path" wasn\'t supplied')
    );
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toContain("wasn't supplied");
  });

  it('maps 422 approve-own-PR shape to BAD_REQUEST', () => {
    const result = classifyGitHubHttpError(
      httpError(422, 'Validation Failed: You cannot approve your own pull request')
    );
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toContain('approve your own');
  });

  it('maps 422 review-submit shape to BAD_REQUEST', () => {
    const result = classifyGitHubHttpError(
      httpError(422, 'Validation Failed: Pull request review thread lock failed')
    );
    expect(result.code).toBe('BAD_REQUEST');
  });

  it('maps 422 update-branch expected_head_sha mismatch to BAD_REQUEST', () => {
    const result = classifyGitHubHttpError(
      httpError(422, "expected head sha didn't match current head ref")
    );
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toContain('expected head sha');
  });

  it('maps 422 merge validation to BAD_REQUEST', () => {
    const result = classifyGitHubHttpError(
      httpError(422, 'Merge commits are not allowed on this repository')
    );
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toContain('Merge commits');
  });

  it('maps 405 to CONFLICT with GitHub message', () => {
    const result = classifyGitHubHttpError(
      httpError(405, '405 Method Not Allowed: Merge method not allowed')
    );
    expect(result.code).toBe('CONFLICT');
    expect(result.message).toContain('Merge method not allowed');
  });

  it('maps 409 to CONFLICT with GitHub message', () => {
    const result = classifyGitHubHttpError(
      httpError(409, 'Merge conflict: HEAD is not a fast-forward')
    );
    expect(result.code).toBe('CONFLICT');
    expect(result.message).toContain('Merge conflict');
  });

  it('maps 5xx to BAD_GATEWAY with a human message', () => {
    const result = classifyGitHubHttpError(httpError(502, 'Bad Gateway'));
    expect(result.code).toBe('BAD_GATEWAY');
  });

  it('falls back to BAD_GATEWAY for non-Error inputs', () => {
    expect(classifyGitHubHttpError('oops').code).toBe('BAD_GATEWAY');
    expect(classifyGitHubHttpError(null).code).toBe('BAD_GATEWAY');
    expect(classifyGitHubHttpError(undefined).code).toBe('BAD_GATEWAY');
  });
});

describe('classifyGitHubGraphQlErrors', () => {
  it('returns null when there are no errors', () => {
    expect(classifyGitHubGraphQlErrors(undefined)).toBeNull();
    expect(classifyGitHubGraphQlErrors([])).toBeNull();
  });

  it('maps GraphQL NOT_FOUND to NOT_FOUND', () => {
    const result = classifyGitHubGraphQlErrors([
      { type: 'NOT_FOUND', message: 'Could not resolve' },
    ]);
    expect(result?.code).toBe('NOT_FOUND');
    expect(result?.message).toBe(
      "PR not found, you don't have access, or the Kilo GitHub App isn't installed for this repository"
    );
  });

  it('maps GraphQL FORBIDDEN to FORBIDDEN preserving message', () => {
    const result = classifyGitHubGraphQlErrors([
      { type: 'FORBIDDEN', message: 'Resource not accessible by integration' },
    ]);
    expect(result?.code).toBe('FORBIDDEN');
    expect(result?.message).toBe('Resource not accessible by integration');
  });

  it('maps GraphQL RATE_LIMITED to TOO_MANY_REQUESTS', () => {
    const result = classifyGitHubGraphQlErrors([{ type: 'RATE_LIMITED', message: 'rate limit' }]);
    expect(result?.code).toBe('TOO_MANY_REQUESTS');
  });

  it('maps GraphQL SECONDARY_RATE_LIMIT to TOO_MANY_REQUESTS', () => {
    const result = classifyGitHubGraphQlErrors([
      { type: 'SECONDARY_RATE_LIMIT', message: 'abuse' },
    ]);
    expect(result?.code).toBe('TOO_MANY_REQUESTS');
  });

  it('falls back to BAD_GATEWAY for unknown GraphQL error types', () => {
    const result = classifyGitHubGraphQlErrors([{ type: 'INTERNAL', message: 'boom' }]);
    expect(result?.code).toBe('BAD_GATEWAY');
    expect(result?.message).toBe('boom');
  });

  it('only considers the first error in the array', () => {
    const result = classifyGitHubGraphQlErrors([
      { type: 'NOT_FOUND', message: 'first' },
      { type: 'FORBIDDEN', message: 'second' },
    ]);
    expect(result?.code).toBe('NOT_FOUND');
  });
});
