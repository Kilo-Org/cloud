import { describe, expect, test } from '@jest/globals';
import {
  redactSecretValues,
  scrubSecretRecord,
  scrubSecrets,
} from '@kilocode/web-shared/lib/observability/sentry-secret-patterns';

const FAKE_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmU';
const FAKE_JWE = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..ZmFrZS1pdg.ZmFrZS1ib2R5.ZmFrZS10YWc';

describe('redactSecretValues', () => {
  test.each([
    [
      'a bearer credential',
      'Authorization: Bearer fake_kilo_token_0123456789',
      'Authorization: Bearer [Filtered]',
    ],
    ['a lower-case bearer credential', 'bearer fake-token-0123456789abcdef', 'bearer [Filtered]'],
    ['a JWT', `token=${FAKE_JWT}&tab=usage`, 'token=[Filtered]&tab=usage'],
    ['a JWE with an empty key segment', `cookie ${FAKE_JWE} end`, 'cookie [Filtered] end'],
    ['an OpenAI-style key', 'key sk-fake0123456789abcdefghij used', 'key [Filtered] used'],
    ['an Anthropic key', 'sk-ant-api03-fake_0123456789abcdef', '[Filtered]'],
    ['an OpenRouter key', '"sk-or-v1-fake0123456789abcdef0123"', '"[Filtered]"'],
    ['a GitHub personal token', 'ghp_fake0123456789abcdefABCDEF', '[Filtered]'],
    ['a GitHub OAuth token', 'gho_fake0123456789abcdefABCDEF', '[Filtered]'],
    ['a GitHub app token', 'ghs_fake0123456789abcdefABCDEF', '[Filtered]'],
    ['a fine-grained GitHub token', 'github_pat_fake0123456789_abcdefABCDEF', '[Filtered]'],
    ['a Slack bot token', 'xoxb-000000-fake-token-value', '[Filtered]'],
    ['a Slack user token', 'xoxp-000000-fake-token-value', '[Filtered]'],
    ['a Slack app token', 'xoxa-000000-fake-token-value', '[Filtered]'],
  ])('replaces %s', (_name, input, expected) => {
    expect(redactSecretValues(input)).toBe(expected);
  });

  test('replaces a bearer value inside a JSON header blob', () => {
    expect(redactSecretValues(`{"Authorization":"Bearer ${FAKE_JWT}","x-foo":"bar"}`)).toBe(
      '{"Authorization":"Bearer [Filtered]","x-foo":"bar"}'
    );
  });

  test('replaces every secret in one string', () => {
    expect(redactSecretValues(`a ${FAKE_JWT} b ghp_fake0123456789abcdefABCDEF c`)).toBe(
      'a [Filtered] b [Filtered] c'
    );
  });

  test.each([
    '0f8fad5b-d9cb-469f-a165-70867728950e',
    'anthropic/claude-sonnet-4',
    'claude-sonnet-4-5-20250929',
    'openai/gpt-5.1-codex',
    'sk-learn',
    'task-0123456789abcdefghijklmnop',
    'Missing Bearer token',
    'The bearer of this request is unknown',
    'ghp_short',
    'xoxb-short',
    'statement timeout after 30000ms on relation "kilocode_users"',
    'https://app.kilo.sh/organizations/0f8fad5b-d9cb-469f-a165-70867728950e/usage?tab=models',
    'fra1::iad1::abcde-1732451234567-0123456789ab',
    'eyJ.not-a-token',
  ])('keeps %s', input => {
    expect(redactSecretValues(input)).toBe(input);
  });
});

describe('scrubSecrets', () => {
  test('filters values under sensitive key names', () => {
    expect(
      scrubSecrets({
        authorization: 'x',
        Cookie: 'a=b',
        'set-cookie': ['a=b'],
        accessToken: 'x',
        refresh_token: 'x',
        'next-auth.session-token': 'x',
        client_secret: 'x',
        newPassword: 'x',
        apiKey: 'x',
        'x-api-key': 'x',
        API_KEY: 'x',
        secretAccessKey: 'x',
        session: { user: { email: 'person@example.com' } },
      })
    ).toEqual({
      authorization: '[Filtered]',
      Cookie: '[Filtered]',
      'set-cookie': '[Filtered]',
      accessToken: '[Filtered]',
      refresh_token: '[Filtered]',
      'next-auth.session-token': '[Filtered]',
      client_secret: '[Filtered]',
      newPassword: '[Filtered]',
      apiKey: '[Filtered]',
      'x-api-key': '[Filtered]',
      API_KEY: '[Filtered]',
      secretAccessKey: '[Filtered]',
      session: '[Filtered]',
    });
  });

  test('keeps identifiers and counts whose names only mention a sensitive word', () => {
    const value = {
      sessionId: 'ses_0123',
      kiloSessionId: 'ses_0123',
      inputTokens: 1200,
      max_tokens: 4096,
      tokenCount: 3,
      apiKeyId: 'key_0123',
      model: 'anthropic/claude-sonnet-4',
      organizationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    };

    expect(scrubSecrets(value)).toEqual(value);
  });

  test('redacts secret-shaped strings in nested arrays and objects', () => {
    expect(
      scrubSecrets({
        args: ['failed', { upstream: { body: `Bearer ${FAKE_JWT}` } }, 42, null, true],
      })
    ).toEqual({
      args: ['failed', { upstream: { body: 'Bearer [Filtered]' } }, 42, null, true],
    });
  });

  test('does not change the input value', () => {
    const input = { nested: { authorization: 'x', note: `Bearer ${FAKE_JWT}` } };

    scrubSecrets(input);

    expect(input).toEqual({ nested: { authorization: 'x', note: `Bearer ${FAKE_JWT}` } });
  });

  test('replaces circular references', () => {
    const input: Record<string, unknown> = { name: 'root' };
    input.self = input;
    input.list = [input];

    expect(scrubSecrets(input)).toEqual({
      name: 'root',
      self: '[Circular]',
      list: ['[Circular]'],
    });
  });

  test('keeps a shared reference that is not circular', () => {
    const shared = { value: 'kept' };

    expect(scrubSecrets({ a: shared, b: shared })).toEqual({ a: shared, b: shared });
  });

  test('filters values below the depth limit', () => {
    let deep: unknown = FAKE_JWT;
    for (let level = 0; level < 20; level++) {
      deep = { next: deep };
    }

    const serialized = JSON.stringify(scrubSecrets(deep));

    expect(serialized).not.toContain('eyJ');
    expect(serialized).toContain('[Filtered]');
  });

  test('keeps at most 1000 entries of an array or object', () => {
    const array = Array.from({ length: 1500 }, (_, index) => index);
    const object = Object.fromEntries(array.map(index => [`key${index}`, index]));

    expect(scrubSecrets(array)).toHaveLength(1000);
    expect(Object.keys(scrubSecretRecord(object))).toHaveLength(1000);
  });

  test.each([undefined, null, 0, false, 'plain text'])('returns %p unchanged', value => {
    expect(scrubSecrets(value)).toBe(value);
  });
});
