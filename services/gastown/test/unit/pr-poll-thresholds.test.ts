import { describe, it, expect } from 'vitest';
import {
  _failureMessageFor,
  _nextPollCounterState,
  _shouldFailImmediately,
  _shouldCountAsTransient,
} from '../../src/dos/town/actions';
import type { PRStatusError } from '../../src/dos/town/town-scm';

describe('failureMessageFor', () => {
  it('produces actionable message for no_token with resolution chain', () => {
    const error: PRStatusError = {
      kind: 'no_token',
      provider: 'github',
      resolutionChain: [
        'town.git_auth.github_token',
        'town.github_cli_pat',
        'town platform integration',
        'rig platform integration',
      ],
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('No GitHub token resolved');
    expect(msg).toContain('`town.git_auth.github_token`');
    expect(msg).toContain('`town.github_cli_pat`');
    expect(msg).toContain('`town platform integration`');
    expect(msg).toContain('`rig platform integration`');
    expect(msg).toContain('polecat agents use their own container credentials');
  });

  it('produces specific message for HTTP 401', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 401,
      statusText: 'Unauthorized',
      transient: false,
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('invalid or expired');
    expect(msg).toContain('HTTP 401');
  });

  it('produces specific message for HTTP 403', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 403,
      statusText: 'Forbidden',
      transient: false,
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('lacks permission');
    expect(msg).toContain('HTTP 403');
  });

  it('produces specific message for HTTP 404', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 404,
      statusText: 'Not Found',
      transient: false,
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('not found');
    expect(msg).toContain('HTTP 404');
  });

  it('produces GitLab-specific messages', () => {
    const noTokenMessage = _failureMessageFor({
      kind: 'no_token',
      provider: 'gitlab',
      resolutionChain: ['town.git_auth.gitlab_token'],
    });
    expect(noTokenMessage).toContain('No GitLab token resolved');

    const forbiddenMessage = _failureMessageFor({
      kind: 'http_error',
      provider: 'gitlab',
      status: 403,
      statusText: 'Forbidden',
      transient: false,
    });
    expect(forbiddenMessage).toContain("Town's GitLab token lacks permission");
    expect(forbiddenMessage).toContain('merge requests');
    expect(forbiddenMessage).not.toContain('pull-requests: read');
  });

  it('produces generic HTTP message for other status codes', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 422,
      statusText: 'Unprocessable Entity',
      transient: false,
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('HTTP 422');
    expect(msg).toContain('Not retryable');
  });

  it('indicates Retrying for transient HTTP errors', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 503,
      statusText: 'Service Unavailable',
      transient: true,
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('Retrying');
  });

  it('produces message with sampleKeys for schema_mismatch', () => {
    const error: PRStatusError = {
      kind: 'invalid_response',
      provider: 'github',
      reason: 'schema_mismatch',
      sampleKeys: ['id', 'title', 'random_field'],
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('unexpected response shape');
    expect(msg).toContain('schema_mismatch');
    expect(msg).toContain('id, title, random_field');
    expect(msg).toContain('file a bug');
  });

  it('produces message without sampleKeys for json_parse', () => {
    const error: PRStatusError = {
      kind: 'invalid_response',
      provider: 'github',
      reason: 'json_parse',
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('json_parse');
    expect(msg).not.toContain('top-level keys');
  });

  it('produces message for unrecognized_url', () => {
    const error: PRStatusError = {
      kind: 'unrecognized_url',
      url: 'https://bitbucket.org/repo/pull/1',
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('not recognized');
    expect(msg).toContain('https://bitbucket.org/repo/pull/1');
  });

  it('produces message for host_mismatch', () => {
    const error: PRStatusError = {
      kind: 'host_mismatch',
      provider: 'gitlab',
      expected: 'gitlab.mycompany.com',
      got: 'gitlab.evil.com',
    };
    const msg = _failureMessageFor(error);
    expect(msg).toContain('Refusing to send GitLab token');
    expect(msg).toContain('gitlab.evil.com');
    expect(msg).toContain('gitlab.mycompany.com');
  });
});

describe('shouldFailImmediately', () => {
  it('returns true for no_token', () => {
    const error: PRStatusError = { kind: 'no_token', provider: 'github', resolutionChain: [] };
    expect(_shouldFailImmediately(error)).toBe(true);
  });

  it('returns true for http_error with transient:false (401)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 401,
      statusText: 'Unauthorized',
      transient: false,
    };
    expect(_shouldFailImmediately(error)).toBe(true);
  });

  it('returns true for http_error with transient:false (403)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 403,
      statusText: 'Forbidden',
      transient: false,
    };
    expect(_shouldFailImmediately(error)).toBe(true);
  });

  it('returns true for http_error with transient:false (404)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 404,
      statusText: 'Not Found',
      transient: false,
    };
    expect(_shouldFailImmediately(error)).toBe(true);
  });

  it('returns false for http_error with transient:true (5xx)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 503,
      statusText: 'Service Unavailable',
      transient: true,
    };
    expect(_shouldFailImmediately(error)).toBe(false);
  });

  it('returns false for invalid_response', () => {
    const error: PRStatusError = {
      kind: 'invalid_response',
      provider: 'github',
      reason: 'schema_mismatch',
    };
    expect(_shouldFailImmediately(error)).toBe(false);
  });

  it('returns true for unrecognized_url', () => {
    const error: PRStatusError = { kind: 'unrecognized_url', url: 'https://example.com' };
    expect(_shouldFailImmediately(error)).toBe(true);
  });

  it('returns true for host_mismatch', () => {
    const error: PRStatusError = {
      kind: 'host_mismatch',
      provider: 'gitlab',
      expected: 'gitlab.com',
      got: 'evil.com',
    };
    expect(_shouldFailImmediately(error)).toBe(true);
  });
});

describe('shouldCountAsTransient', () => {
  it('returns true for http_error with transient:true (5xx)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 503,
      statusText: 'Service Unavailable',
      transient: true,
    };
    expect(_shouldCountAsTransient(error)).toBe(true);
  });

  it('returns true for http_error with transient:true (429)', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 429,
      statusText: 'Too Many Requests',
      transient: true,
    };
    expect(_shouldCountAsTransient(error)).toBe(true);
  });

  it('returns false for http_error with transient:false', () => {
    const error: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 401,
      statusText: 'Unauthorized',
      transient: false,
    };
    expect(_shouldCountAsTransient(error)).toBe(false);
  });

  it('returns false for non-http_error kinds', () => {
    const error: PRStatusError = { kind: 'no_token', provider: 'github', resolutionChain: [] };
    expect(_shouldCountAsTransient(error)).toBe(false);
  });
});

describe('error categorization is mutually exclusive', () => {
  const allKinds: PRStatusError[] = [
    { kind: 'no_token', provider: 'github', resolutionChain: [] },
    {
      kind: 'http_error',
      provider: 'github',
      status: 401,
      statusText: 'Unauthorized',
      transient: false,
    },
    {
      kind: 'http_error',
      provider: 'github',
      status: 503,
      statusText: 'Service Unavailable',
      transient: true,
    },
    { kind: 'invalid_response', provider: 'github', reason: 'schema_mismatch' },
    { kind: 'unrecognized_url', url: 'https://example.com' },
    { kind: 'host_mismatch', provider: 'gitlab', expected: 'gitlab.com', got: 'evil.com' },
  ];

  it('each error kind falls into exactly one bucket', () => {
    for (const error of allKinds) {
      const buckets = [_shouldFailImmediately(error), _shouldCountAsTransient(error)].filter(
        Boolean
      );
      expect(buckets.length, `${error.kind} should match exactly one bucket`).toBeLessThanOrEqual(
        1
      );
    }
  });

  it('invalid_response is the only kind in the 3-strike (non-transient) bucket', () => {
    for (const error of allKinds) {
      const isNonTransient = !_shouldFailImmediately(error) && !_shouldCountAsTransient(error);
      if (error.kind === 'invalid_response') {
        expect(isNonTransient, `invalid_response should be in 3-strike bucket`).toBe(true);
      } else {
        expect(isNonTransient, `${error.kind} should NOT be in 3-strike bucket`).toBe(false);
      }
    }
  });
});

describe('counter cross-contamination', () => {
  it('9 transient errors then 1 non-transient should not fail (separate counters)', () => {
    const transientError: PRStatusError = {
      kind: 'http_error',
      provider: 'github',
      status: 503,
      statusText: 'Service Unavailable',
      transient: true,
    };
    const nonTransientError: PRStatusError = {
      kind: 'invalid_response',
      provider: 'github',
      reason: 'schema_mismatch',
    };

    let state = { pollTransientCount: 0, pollNonTransientCount: 0, shouldFail: false };
    for (let i = 0; i < 9; i++) {
      state = _nextPollCounterState(transientError, state);
    }

    expect(state).toEqual({
      pollTransientCount: 9,
      pollNonTransientCount: 0,
      shouldFail: false,
    });

    state = _nextPollCounterState(nonTransientError, state);

    expect(state).toEqual({
      pollTransientCount: 0,
      pollNonTransientCount: 1,
      shouldFail: false,
    });
  });

  it('3 consecutive non-transient errors should fail (non-transient counter reaches threshold)', () => {
    const nonTransientError: PRStatusError = {
      kind: 'invalid_response',
      provider: 'github',
      reason: 'schema_mismatch',
    };

    let state = { pollTransientCount: 0, pollNonTransientCount: 0, shouldFail: false };
    for (let i = 0; i < 3; i++) {
      state = _nextPollCounterState(nonTransientError, state);
    }

    expect(state).toEqual({
      pollTransientCount: 0,
      pollNonTransientCount: 3,
      shouldFail: true,
    });
  });
});
