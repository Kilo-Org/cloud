import { describe, expect, test } from '@jest/globals';
import {
  MAX_REDACTED_TEXT_LENGTH,
  redactSecretValues,
  scrubSecretRecord,
  scrubSecrets,
} from '@kilocode/web-shared/lib/observability/sentry-secret-patterns';

// Secret-shaped fakes are assembled at run time from split parts, so no literal
// in this file matches a provider's secret scanner.
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlIn0', 'fakesignature0000'].join('.');
const FAKE_JWE = [
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0',
  '',
  'fakeiv0000',
  'fakeciphertext0000',
  'faketag0000',
].join('.');
const FAKE_OPENAI_KEY = ['sk', '-proj-', 'fake'.repeat(8)].join('');
const FAKE_ANTHROPIC_KEY = ['sk', '-ant-', 'api03-', 'fake'.repeat(8)].join('');
const FAKE_OPENROUTER_KEY = ['sk', '-or-', 'v1-', 'fake'.repeat(8)].join('');
const FAKE_GITHUB_TOKEN = ['gh', 'p_', 'fake0123456789abcdefABCDEF'].join('');
const FAKE_GITHUB_OAUTH_TOKEN = ['gh', 'o_', 'fake0123456789abcdefABCDEF'].join('');
const FAKE_GITHUB_APP_TOKEN = ['gh', 's_', 'fake0123456789abcdefABCDEF'].join('');
const FAKE_GITHUB_PAT = ['github', '_pat_', 'fake0123456789_abcdefABCDEF'].join('');
const FAKE_SLACK_BOT_TOKEN = ['xo', 'xb-', '0000-0000-fakefakefake'].join('');
const FAKE_SLACK_USER_TOKEN = ['xo', 'xp-', '0000-0000-fakefakefake'].join('');
const FAKE_SLACK_APP_TOKEN = ['xo', 'xa-', '0000-0000-fakefakefake'].join('');
const FAKE_STRIPE_LIVE_KEY = ['sk', '_live_', 'x'.repeat(24)].join('');
const FAKE_STRIPE_TEST_KEY = ['sk', '_test_', 'x'.repeat(24)].join('');
const FAKE_STRIPE_RESTRICTED_KEY = ['rk', '_live_', 'x'.repeat(24)].join('');
const FAKE_STRIPE_WEBHOOK_SECRET = ['whs', 'ec_', 'x'.repeat(24)].join('');
const FAKE_GITLAB_TOKEN = ['gl', 'pat-', 'x'.repeat(20)].join('');
const FAKE_GOOGLE_TOKEN = ['ya', '29.', 'FAKE'.repeat(6)].join('');
const FAKE_GOOGLE_API_KEY = ['AI', 'za', 'fake'.repeat(8), '1_-'].join('');
const FAKE_GOOGLE_AUTH_KEY = ['A', 'Q.', 'fake0123'.repeat(5)].join('');
const FAKE_NPM_TOKEN = ['np', 'm_', 'fake0123'.repeat(4), 'AbC4'].join('');
const FAKE_SENTRY_USER_TOKEN = ['sntry', 'u_', 'abcd0123'.repeat(8)].join('');
const FAKE_SENTRY_ORG_TOKEN_PREFIX = [
  'sntry',
  's_',
  Buffer.from(
    JSON.stringify({
      iat: 123,
      url: 'https://example.com',
      region_url: 'https://example.com',
      org: 'example',
    })
  ).toString('base64'),
  '_',
].join('');
const FAKE_SENTRY_ORG_TOKEN = `${FAKE_SENTRY_ORG_TOKEN_PREFIX}${Buffer.alloc(32, 0xfb)
  .toString('base64')
  .replace(/=+$/, '')}`;
const SLACK_WEBHOOK_HOST = ['https://hooks', 'slack.com'].join('.');
const DISCORD_WEBHOOK_PATH = ['/api', 'webhooks'].join('/');
const PRIVATE_KEY_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const FAKE_DATABASE_URL = [
  ['post', 'gres://'].join(''),
  ['app_user', 'fake-password'].join(':'),
  '@db.internal:5432/app',
].join('');

describe('redactSecretValues', () => {
  test.each([
    [
      'a bearer credential',
      'Authorization: Bearer fake_kilo_token_0123456789',
      'Authorization: Bearer [Filtered]',
    ],
    ['a lower-case bearer credential', 'bearer fake-token-0123456789abcdef', 'bearer [Filtered]'],
    [
      'a basic credential',
      'Authorization: Basic ZmFrZS11c2VyOmZha2UtcGFzc3dvcmQ=',
      'Authorization: Basic [Filtered]',
    ],
    ['a JWT', `token=${FAKE_JWT}&tab=usage`, 'token=[Filtered]&tab=usage'],
    ['a JWE with an empty key segment', `cookie ${FAKE_JWE} end`, 'cookie [Filtered] end'],
    ['an OpenAI-style key', `key ${FAKE_OPENAI_KEY} used`, 'key [Filtered] used'],
    ['an Anthropic key', FAKE_ANTHROPIC_KEY, '[Filtered]'],
    ['an OpenRouter key', `"${FAKE_OPENROUTER_KEY}"`, '"[Filtered]"'],
    ['a GitHub personal token', FAKE_GITHUB_TOKEN, '[Filtered]'],
    ['a GitHub OAuth token', FAKE_GITHUB_OAUTH_TOKEN, '[Filtered]'],
    ['a GitHub app token', FAKE_GITHUB_APP_TOKEN, '[Filtered]'],
    ['a fine-grained GitHub token', FAKE_GITHUB_PAT, '[Filtered]'],
    ['a Slack bot token', FAKE_SLACK_BOT_TOKEN, '[Filtered]'],
    ['a Slack user token', FAKE_SLACK_USER_TOKEN, '[Filtered]'],
    ['a Slack app token', FAKE_SLACK_APP_TOKEN, '[Filtered]'],
    ['a Google API key', `failed for ${FAKE_GOOGLE_API_KEY}`, 'failed for [Filtered]'],
    ['a Google authorization key', FAKE_GOOGLE_AUTH_KEY, '[Filtered]'],
    ['an npm access token', FAKE_NPM_TOKEN, '[Filtered]'],
    ['a Sentry user token', FAKE_SENTRY_USER_TOKEN, '[Filtered]'],
    ['a Sentry organization token', `(${FAKE_SENTRY_ORG_TOKEN})`, '([Filtered])'],
    [
      'a Sentry organization token with a slash segment',
      `${FAKE_SENTRY_ORG_TOKEN_PREFIX}/s/${'A'.repeat(40)}`,
      '[Filtered]',
    ],
  ])('replaces %s', (_name, input, expected) => {
    expect(redactSecretValues(input)).toBe(expected);
  });

  test('replaces a bearer value inside a JSON header blob', () => {
    expect(redactSecretValues(`{"Authorization":"Bearer ${FAKE_JWT}","x-foo":"bar"}`)).toBe(
      '{"Authorization":"[Filtered]","x-foo":"bar"}'
    );
  });

  test('replaces every secret in one string', () => {
    expect(redactSecretValues(`a ${FAKE_JWT} b ${FAKE_GITHUB_TOKEN} c`)).toBe(
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
    'Basic plan users get 5 requests',
    'ghp_short',
    'xoxb-short',
    'AIza-short',
    'AQ.short',
    'npm_install_job',
    'sntryu_placeholder',
    'sntrys_version_name',
    'statement timeout after 30000ms on relation "kilocode_users"',
    'https://app.kilo.sh/organizations/0f8fad5b-d9cb-469f-a165-70867728950e/usage?tab=models',
    'fra1::iad1::abcde-1732451234567-0123456789ab',
    'eyJ.not-a-token',
  ])('keeps %s', input => {
    expect(redactSecretValues(input)).toBe(input);
  });

  test.each([
    ['repeated JWT starts', 'eyJ-'.repeat(50_000)],
    ['repeated JWT starts after one dot', `eyJ.${'eyJ-'.repeat(50_000)}`],
    ['a JWT start with one long segment', `eyJa.${'a'.repeat(200_000)}`],
    ['a bearer prefix with long whitespace', `Bearer${' '.repeat(200_000)}`],
    ['repeated key prefixes', 'sk-x '.repeat(40_000)],
    ['a Sentry token prefix with no delimiter', `sntrys_eyJ${'a'.repeat(200_000)}`],
  ])('redacts 200 KB of %s in linear time', (_name, input) => {
    const started = performance.now();
    redactSecretValues(input, input.length);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test('keeps text up to the length limit unchanged', () => {
    const text = 'a '.repeat(MAX_REDACTED_TEXT_LENGTH / 2);

    expect(redactSecretValues(text)).toBe(text);
  });

  test('truncates longer text and marks the cut', () => {
    const result = redactSecretValues('a '.repeat(MAX_REDACTED_TEXT_LENGTH));

    expect(result).toBe(`${'a '.repeat(MAX_REDACTED_TEXT_LENGTH / 2)}[Truncated]`);
  });

  test.each([
    ['a provider key', `error ${FAKE_ANTHROPIC_KEY}`, 'error [Truncated]'],
    ['a JWT', `error ${FAKE_JWT}`, 'error [Truncated]'],
    [
      'a bearer value',
      'Authorization: Bearer fake_kilo_token_0123',
      'Authorization: Bearer [Filtered][Truncated]',
    ],
  ])('drops the part of %s that the cut leaves', (_name, input, expected) => {
    expect(redactSecretValues(input, 26)).toBe(expected);
  });

  test('redacts a whole secret before the cut', () => {
    expect(redactSecretValues(`${FAKE_JWT} and more text`, FAKE_JWT.length + 5)).toBe(
      '[Filtered] and [Truncated]'
    );
  });

  test.each([
    [
      'a Slack webhook URL',
      `POST ${SLACK_WEBHOOK_HOST}/services/TFAKE0000/BFAKE0000/fakeWebhookPath0000 failed`,
      'POST https://hooks.slack.com/[Filtered] failed',
    ],
    [
      'a Discord webhook URL',
      `https://discord.com${DISCORD_WEBHOOK_PATH}/000000000000000000/fake-webhook-path_0000`,
      'https://discord.com/api/webhooks/[Filtered]',
    ],
    [
      'a versioned Discord webhook URL',
      `https://canary.discordapp.com/api/v10/webhooks/${'0000'}/fake-path`,
      'https://canary.discordapp.com/api/v10/webhooks/[Filtered]',
    ],
    [
      'URL userinfo',
      `connect ${FAKE_DATABASE_URL} failed`,
      'connect postgres://[Filtered]@db.internal:5432/app failed',
    ],
    [
      'URL userinfo with a user only',
      'fetch https://fake-user@git.example.com/repo.git',
      'fetch https://[Filtered]@git.example.com/repo.git',
    ],
    [
      'an access token query value',
      'GET https://api.example.com/v1/items?page=2&access_token=fake-value-0000&sort=asc',
      'GET https://api.example.com/v1/items?page=2&access_token=[Filtered]&sort=asc',
    ],
    [
      'an API key query value',
      'https://maps.example.com/q?key=fake-key-0000',
      'https://maps.example.com/q?key=[Filtered]',
    ],
    [
      'an OAuth code next to an allowed value',
      '/callback?code=fake-code-0000&state=s1',
      '/callback?code=[Filtered]&state=s1',
    ],
    [
      'signed URL parameters',
      'https://bucket.example.com/f?X-Amz-Credential=fake%2F0000&X-Amz-Signature=fake0000&X-Amz-Expires=60',
      'https://bucket.example.com/f?X-Amz-Credential=[Filtered]&X-Amz-Signature=[Filtered]&X-Amz-Expires=60',
    ],
    [
      'a token in a percent-encoded nested URL',
      'callbackPath=%2Fcb%3Ftoken%3Dfake-value-0000%26page%3D2',
      'callbackPath=%2Fcb%3Ftoken%3D[Filtered]%26page%3D2',
    ],
    [
      'a token in a nested URL',
      '/sign-in?callbackPath=/cb?share_token=fake-value-0000',
      '/sign-in?callbackPath=/cb?share_token=[Filtered]',
    ],
    [
      'a password pair in a log line',
      'login failed password=fake-pass-0000 host=db',
      'login failed password=[Filtered] host=db',
    ],
    [
      'a session cookie',
      'Cookie: theme=dark; __Secure-next-auth.session-token=fake-value-0000; Path=/',
      'Cookie: [Filtered]',
    ],
    [
      'a bearer token echoed in a Headers.set error',
      'TypeError: Headers.set: "Bearer fake-header-value-0000-abcd\n" is an invalid header value.',
      'TypeError: Headers.set: "Bearer [Filtered]\n" is an invalid header value.',
    ],
    [
      'a share link path in an error message',
      'Shared session not found: https://app.kilo.ai/s/fake-share-0000',
      'Shared session not found: https://app.kilo.ai/s/:share_token',
    ],
    [
      'a device-auth user code path',
      'GET /api/device-auth/codes/FAKE-0000',
      'GET /api/device-auth/codes/:code',
    ],
    [
      'an invitation token path',
      'https://app.kilo.ai/users/accept-invite/fake-invite-0000?x=1',
      'https://app.kilo.ai/users/accept-invite/:token?x=1',
    ],
    ['a Stripe live key', `key ${FAKE_STRIPE_LIVE_KEY}`, 'key [Filtered]'],
    ['a Stripe test key', FAKE_STRIPE_TEST_KEY, '[Filtered]'],
    ['a Stripe restricted key', FAKE_STRIPE_RESTRICTED_KEY, '[Filtered]'],
    ['a Stripe webhook secret', FAKE_STRIPE_WEBHOOK_SECRET, '[Filtered]'],
    ['a GitLab token', FAKE_GITLAB_TOKEN, '[Filtered]'],
    ['a Google OAuth token', FAKE_GOOGLE_TOKEN, '[Filtered]'],
    [
      'a JSON credential value',
      '{"access_token":"fake-value-0000","token_type":"bearer","expires_in":3600}',
      '{"access_token":"[Filtered]","token_type":"bearer","expires_in":3600}',
    ],
    [
      'a JSON one-time code',
      '{"code": "123456", "error": "x"}',
      '{"code": "[Filtered]", "error": "x"}',
    ],
    [
      'a header line in error text',
      'upstream rejected X-Api-Key: fake-key-value-0000 with 401',
      'upstream rejected X-Api-Key: [Filtered] with 401',
    ],
    [
      'a header value with base64 padding',
      'sent X-Api-Key: ZmFrZS1rZXk= upstream',
      'sent X-Api-Key: [Filtered] upstream',
    ],
    ['a short header value', 'otp: 123456 rejected', "otp: '[Filtered]' rejected"],
    [
      'a scheme and value in a header line',
      'Authorization: Token fake-replicate-0000',
      'Authorization: Token [Filtered]',
    ],
    ['a JSON number one-time code', '{"otp":123456,"tries":2}', '{"otp":"[Filtered]","tries":2}'],
    [
      'an inspected credential value',
      "{ access_token: 'fake-value-0000', expires_in: 3600 }",
      "{ access_token: '[Filtered]', expires_in: 3600 }",
    ],
    [
      'an inspected one-time code',
      '{ verificationCode: 654321 }',
      "{ verificationCode: '[Filtered]' }",
    ],
    [
      'a snake-case header name',
      'client_secret: fake-secret-0000 rejected',
      'client_secret: [Filtered] rejected',
    ],
    ['an access token header line', 'access_token: fake-value-0000', 'access_token: [Filtered]'],
    ['a quoted header value', 'password: "fake pass 0000" given', 'password: "[Filtered]" given'],
    [
      'a quoted value after a scheme',
      'Authorization: Token "fake-value-0000"',
      'Authorization: Token [Filtered]',
    ],
    [
      'an inspected quoted name',
      "{ 'x-api-key': 'fake-key-0000' }",
      "{ 'x-api-key': '[Filtered]' }",
    ],
    [
      'an unknown authorization scheme',
      'Authorization: Splunk fake-hec-0000',
      'Authorization: [Filtered]',
    ],
    [
      'an Okta authorization scheme',
      'authorization: SSWS fake-okta-0000 x',
      'authorization: [Filtered]',
    ],
    [
      'an API key authorization scheme',
      'Proxy-Authorization: ApiKey fake-0000',
      'Proxy-Authorization: [Filtered]',
    ],
    [
      'every cookie of a cookie line',
      'Cookie: theme=dark; kilo_sid=fake-0000',
      'Cookie: [Filtered]',
    ],
    [
      'a device flow user code',
      '{"user_code":"WDJB-MJHT","interval":5}',
      '{"user_code":"[Filtered]","interval":5}',
    ],
    [
      'an authorization header line after a newline',
      'GET /v1/models\nAuthorization: Splunk fake-hec-0000 extra\nHost: api.example.com',
      'GET /v1/models\nAuthorization: [Filtered]\nHost: api.example.com',
    ],
    [
      'an inline authorization field and keeps the fields after it',
      'error: denied; authorization: Splunk fake-hec-0000; model: gpt-5 retry',
      'error: denied; authorization: [Filtered]; model: gpt-5 retry',
    ],
    [
      'an inline known scheme and keeps the fields after it',
      'rejected {authorization: Token fake-0000, model: gpt-5}',
      'rejected {authorization: Token [Filtered], model: gpt-5}',
    ],
    [
      'an inline cookie field and keeps the fields after it',
      'request failed cookie: kilo_sid=fake-0000; model=gpt-5',
      'request failed cookie: [Filtered]; model=gpt-5',
    ],
    [
      'a curl request cookie line',
      '* Connected\n> GET /v1 HTTP/2\n> Cookie: a=b; x_sid=fake-0000\n> Accept: */*',
      '* Connected\n> GET /v1 HTTP/2\n> Cookie: [Filtered]\n> Accept: */*',
    ],
    [
      'a curl response set-cookie line',
      '< HTTP/2 200\n< set-cookie: theme=dark; kilo_sid=fake-0000; Path=/',
      '< HTTP/2 200\n< set-cookie: [Filtered]',
    ],
    [
      'an indented authorization line',
      'headers:\n\tAuthorization: Splunk fake-hec-0000 extra',
      'headers:\n\tAuthorization: [Filtered]',
    ],
  ])('replaces %s', (_name, input, expected) => {
    expect(redactSecretValues(input)).toBe(expected);
  });

  test('replaces a private key block', () => {
    const header = ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' ');
    const footer = ['-----END', 'RSA PRIVATE', 'KEY-----'].join(' ');

    expect(redactSecretValues(`key ${header}\nZmFrZS1rZXk=\nZmFrZQ==\n${footer} end`)).toBe(
      'key [Filtered] end'
    );
    expect(redactSecretValues(`{"pem":"${header}\\nZmFrZS1rZXk=\\n${footer}"}`)).toBe(
      '{"pem":"[Filtered]"}'
    );
  });

  test('replaces a private key block that the cut leaves without its end line', () => {
    const header = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    const text = `${header}\n${'ZmFrZS1rZXk='.repeat(10)}`;

    expect(redactSecretValues(text, header.length + 40)).toBe('[Filtered][Truncated]');
  });

  test('drops a cut query value', () => {
    expect(redactSecretValues('GET /x?token=fake-value-0000', 18)).toBe('GET /x?[Truncated]');
  });

  test.each([
    'https://app.kilo.sh/usage?page=2&tab=models&sort=desc',
    '/oauth/authorize?code_challenge_method=S256&response_type=code&state=s1',
    'error_code=invalid_grant max_tokens=4096',
    'react@19.2.0 and @sentry/nextjs@11.12.0',
    'User person@example.com not found',
    'ssh -p 22 deploy@10.0.0.1',
    'version 1.2.3-beta.4+build.5',
    'request 0f8fad5b-d9cb-469f-a165-70867728950e at https://api.example.com:8443/v1/items',
    'key=',
    'a == b',
    '{"code":"invalid_grant","error_code":"rate_limited","status":429}',
    'Error: request failed after retries statusCode: 404',
    'sk_live_short',
    '{"code":"1113","message":"insufficient balance"}',
    "{ errorCode: '1113', code: '23505', statusCode: 404 }",
    'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
  ])('keeps %s', input => {
    expect(redactSecretValues(input)).toBe(input);
  });

  // Each case is built from near matches of a pattern at two sizes. The length
  // argument skips the cut, so the patterns run on all of the text. Linear
  // redaction of the large text does the same work as SIZE_FACTOR redactions of
  // the small text, so the time ratio is about 1; a pattern that rescans its
  // input makes it about SIZE_FACTOR. Both spans of a pair are about equally
  // long and run one after the other, so a slow or busy runner stretches both
  // by about the same factor. The median of several pairs leaves out a pair in
  // which pattern compilation, garbage collection or a change in load falls on
  // one span only.
  const LARGE_SIZE = 100_000;
  const SIZE_FACTOR = 16;
  const MAX_TIME_RATIO = 4;
  const RUNS = 5;
  type Build = (size: number) => string;
  const nearMatches =
    (fragment: string, suffix = ''): Build =>
    size =>
      fragment.repeat(Math.ceil(size / fragment.length)) + suffix;
  const longValue =
    (prefix: string, unit = 'a'): Build =>
    size =>
      prefix + unit.repeat(Math.ceil(size / unit.length));
  const redactionTime = (input: string, count: number) => {
    const started = performance.now();
    for (let run = 0; run < count; run++) {
      redactSecretValues(input, input.length);
    }
    return performance.now() - started;
  };
  test.each<[string, Build]>([
    ['parameter: repeated plain pairs', nearMatches('?a=b')],
    ['parameter: one long value', longValue('?a=', 'b')],
    ['parameter: one long percent-encoded value', longValue('?a=', '%41')],
    ['parameter: repeated sensitive pairs', nearMatches('&token=x')],
    ['parameter: repeated empty sensitive pairs', nearMatches('?token=')],
    ['parameter: repeated encoded separators', nearMatches('%3Fa%3D%')],
    ['parameter: a long name', longValue('&')],
    ['parameter: repeated whitespace', nearMatches(' ')],
    ['private key: repeated begin fragments', nearMatches('-----BEGIN ')],
    ['private key: repeated headers', nearMatches(PRIVATE_KEY_HEADER)],
    ['private key: headers with short bodies', nearMatches(`${PRIVATE_KEY_HEADER}ZmFr-`)],
    ['userinfo: repeated scheme and user fragments', nearMatches('https://a:')],
    ['userinfo: repeated schemes', nearMatches('https://')],
    ['webhook: repeated Slack paths without a scheme', nearMatches('hooks.slack.com/services/')],
    ['webhook: repeated Slack URLs', nearMatches('https://hooks.slack.com/')],
    ['webhook: repeated Discord URLs', nearMatches('https://discord.com/api/webhooks/')],
    ['webhook: a long Slack path', longValue('https://hooks.slack.com/')],
    ['capability path: repeated share prefixes', nearMatches('/s/')],
    ['capability path: repeated device-auth prefixes', nearMatches('/device-auth/codes/')],
    ['value: repeated Stripe prefixes', nearMatches('sk_live_')],
    ['JSON pair: repeated credential keys', nearMatches('"access_token":"')],
    ['JSON pair: repeated short pairs', nearMatches('"a":"')],
    ['JSON pair: one unterminated value', longValue('"access_token":"')],
    ['header line: repeated credential names', nearMatches('X-Api-Key: ')],
    ['header line: repeated values with =', nearMatches('a: bbbbbbbb=')],
    ['header line: nested braces before a value', nearMatches('{a:', '=')],
    ['header line: nested quotes before a value', nearMatches('"a:', '=')],
    ['header line: nested commas before a value', nearMatches(',a:', '=')],
    ['header line: repeated schemes', nearMatches('{token: Bearer ')],
    ['inspect pair: repeated credential keys', nearMatches("{ token: '")],
    ['inspect pair: one unterminated value', longValue("{ token: '")],
    ['JSON pair: repeated number pairs', nearMatches('"otp":1,')],
    ['JSON pair: repeated plain pairs', nearMatches('"a":"b",')],
    ['header line: repeated authorization names', nearMatches('{authorization: ')],
    ['header line: repeated near authorization names', nearMatches('{authorizatio:')],
    ['header line: repeated quoted values', nearMatches('{a: "')],
    ['header line: one unterminated quoted value', longValue('{password: "')],
    ['header line: repeated snake-case names', nearMatches('{client_secret:')],
    ['header line: repeated dotted names', nearMatches('{a.b_c:')],
    ['inspect pair: repeated quoted names', nearMatches("{'a': '")],
    ['inspect pair: one unterminated value after a quoted name', longValue("{ 'token': '")],
    ['header line: repeated inline authorization fields', nearMatches(' authorization: a ')],
    ['header line: repeated line-start authorization fields', nearMatches('\nauthorization:')],
    ['header line: repeated inline cookie fields', nearMatches(' cookie: a=')],
    ['header line: repeated curl cookie lines', nearMatches('\n> cookie:')],
    ['header line: repeated indented marker starts', nearMatches('\n  < \t')],
    ['header line: one unterminated quoted authorization value', longValue(' authorization: "')],
    [
      'header line: one unterminated quoted value after a scheme',
      longValue(' authorization: Bearer "'),
    ],
  ])('redacts %s in linear time', (_name, build) => {
    const small = build(LARGE_SIZE / SIZE_FACTOR);
    const large = build(LARGE_SIZE);
    const ratios = Array.from({ length: RUNS }, () => {
      const smallTime = redactionTime(small, SIZE_FACTOR);
      return redactionTime(large, 1) / smallTime;
    }).sort((a, b) => a - b);
    expect(ratios[Math.floor(RUNS / 2)]).toBeLessThan(MAX_TIME_RATIO);
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
        secretKey: 'x',
        STRIPE_SECRET_KEY: 'x',
        signingKey: 'x',
        encryption_key: 'x',
        apiTokenPepper: 'x',
        authHeader: 'x',
        cookieHeader: 'x',
        secretAccessKey: 'x',
        session: { user: { email: 'person@example.com' } },
      })
    ).toEqual({
      secretKey: '[Filtered]',
      STRIPE_SECRET_KEY: '[Filtered]',
      signingKey: '[Filtered]',
      encryption_key: '[Filtered]',
      apiTokenPepper: '[Filtered]',
      authHeader: '[Filtered]',
      cookieHeader: '[Filtered]',
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

  test('filters one-time codes and PEM keys by key name and code shape', () => {
    expect(
      scrubSecrets({
        otp: '123456',
        pin: '1234',
        verificationCode: '654321',
        code: 'fakeOpaqueToken0000abcd',
        private_key_pem: 'fake',
        errorCode: 'E_UPSTREAM',
        code_type: 'oauth',
        statusCode: 404,
        exitCode: 1,
        upstreamErrorCode: '1113',
        databaseErrorCode: '23505',
        sqlCode: '23505',
        user_code: 'WDJB-MJHT',
        deviceCode: 'GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9e',
        googleCode: '4/0AeaYSHB-FAKE-0000/abcdefghijklmnop',
        slackCode: '1234567890.1234567890123.abcdef0123456789',
      })
    ).toEqual({
      otp: '[Filtered]',
      pin: '[Filtered]',
      verificationCode: '[Filtered]',
      code: '[Filtered]',
      private_key_pem: '[Filtered]',
      errorCode: 'E_UPSTREAM',
      code_type: 'oauth',
      statusCode: 404,
      exitCode: 1,
      upstreamErrorCode: '1113',
      databaseErrorCode: '23505',
      sqlCode: '23505',
      user_code: '[Filtered]',
      deviceCode: '[Filtered]',
      googleCode: '[Filtered]',
      slackCode: '[Filtered]',
    });
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
