import { describe, expect, test } from '@jest/globals';
import {
  describeByokEndpointError,
  redactByokEndpointSecrets,
  type ByokEndpointResponse,
} from './endpoint-upstream';

const API_KEY = 'sk-proj-AbCdEfGh1234567890wxyz';

function failure(text: string, secrets: readonly string[] = [API_KEY]): ByokEndpointResponse {
  return { status: 401, ok: false, text, secrets };
}

describe('describeByokEndpointError', () => {
  test('prefers the message of a JSON error body', () => {
    const response = failure(JSON.stringify({ error: { message: 'bad key' }, trace: 'long' }));

    expect(describeByokEndpointError(response)).toBe('HTTP 401: bad key');
  });

  test('reads a string error and falls back to the text of a non-JSON body', () => {
    expect(describeByokEndpointError(failure(JSON.stringify({ error: 'nope' })))).toBe(
      'HTTP 401: nope'
    );
    expect(describeByokEndpointError(failure(' Unauthorized '))).toBe('HTTP 401: Unauthorized');
    expect(describeByokEndpointError(failure(''))).toBe('HTTP 401');
  });

  test('keeps at most 300 characters of the detail', () => {
    expect(describeByokEndpointError(failure('x'.repeat(1000)))).toBe(
      `HTTP 401: ${'x'.repeat(300)}`
    );
  });

  test('redacts a credential the upstream echoes in a JSON message', () => {
    const response = failure(JSON.stringify({ error: { message: `Invalid key ${API_KEY}.` } }));

    expect(describeByokEndpointError(response)).toBe('HTTP 401: Invalid key [redacted].');
  });

  test('redacts a credential the upstream echoes in a plain text body', () => {
    expect(describeByokEndpointError(failure(`Bad credentials: ${API_KEY}`))).toBe(
      'HTTP 401: Bad credentials: [redacted]'
    );
  });

  test.each([
    ['a masked middle', 'Incorrect API key provided: sk-proj-********wxyz.'],
    ['a prefix only', 'Incorrect API key provided: sk-proj-AbCd.'],
    ['a suffix only', 'Incorrect API key provided: ...7890wxyz.'],
  ])('redacts the visible ends of %s', (_case, message) => {
    const described = describeByokEndpointError(failure(message));

    expect(described).not.toContain('sk-proj-');
    expect(described).not.toContain('wxyz');
    expect(described).toContain('[redacted]');
  });

  test('redacts every secret of the credentials, including a derived token', () => {
    const secrets = ['AKIAEXAMPLEKEYID123', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'];
    const response = failure(`${secrets[1]} for ${secrets[0]}`, secrets);

    expect(describeByokEndpointError(response)).toBe('HTTP 401: [redacted] for [redacted]');
  });

  test('keeps text that shares no run with a secret', () => {
    expect(describeByokEndpointError(failure('Rate limit exceeded, retry later'))).toBe(
      'HTTP 401: Rate limit exceeded, retry later'
    );
  });
});

describe('redactByokEndpointSecrets', () => {
  test('does not match regular expression characters in a secret', () => {
    expect(redactByokEndpointSecrets('key a+b.c*d(e) end', ['a+b.c*d(e)'])).toBe(
      'key [redacted] end'
    );
  });

  test('redacts the full secret even when it is too long for partial matching', () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(1700)}\n-----END PRIVATE KEY-----`;

    expect(redactByokEndpointSecrets(`x ${privateKey}`, [privateKey])).toBe('x [redacted]');
  });

  test('ignores empty secrets', () => {
    expect(redactByokEndpointSecrets('text', [''])).toBe('text');
  });
});
