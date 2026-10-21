import { createHash, createHmac } from 'node:crypto';
import type { CustomLlmAwsBedrockCredentials } from '@kilocode/db/schema-types';
import { buildDirectProvider } from './build-direct-provider';
import { upstreamRequest } from './upstream-request';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));

const originalFetch = global.fetch;

const credentials: CustomLlmAwsBedrockCredentials = {
  type: 'aws_bedrock',
  region: 'us-west-2',
  access_key_id: 'AKIDEXAMPLE',
  secret_access_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

async function sendToBedrock(base_url: string) {
  const fetchMock = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}')
  );
  global.fetch = fetchMock;

  const result = await upstreamRequest({
    chatApi: 'chat_completions',
    search: '',
    method: 'POST',
    body: { model: 'openai.gpt-oss-120b-1:0', messages: [{ role: 'user', content: 'hi' }] },
    extraHeaders: { 'x-definition-header': 'definition' },
    provider: buildDirectProvider(
      'custom',
      ['chat_completions'],
      { base_url },
      { type: 'aws_bedrock', credentials }
    ),
    reasoningEffort: null,
  });

  expect(result.type).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), headers: new Headers(init?.headers), body: String(init?.body) };
}

function parseAuthorization(authorization: string) {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization
    );
  if (!match) throw new Error(`unexpected authorization header: ${authorization}`);
  const [, accessKeyId, date, region, service, signedHeaders, signature] = match;
  return { accessKeyId, date, region, service, signedHeaders: signedHeaders.split(';'), signature };
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string) {
  return createHmac('sha256', key).update(value).digest();
}

/** Independent SigV4 computation for paths that need no extra encoding. */
function expectedSignature({
  url,
  headers,
  body,
  service,
  signedHeaders,
}: {
  url: URL;
  headers: Headers;
  body: string;
  service: string;
  signedHeaders: string[];
}) {
  const amzDate = headers.get('x-amz-date') ?? '';
  const date = amzDate.slice(0, 8);
  const canonicalHeaders = signedHeaders
    .map(name => `${name}:${name === 'host' ? url.host : headers.get(name)}\n`)
    .join('');
  const canonicalRequest = [
    'POST',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    sha256Hex(body),
  ].join('\n');
  const scope = `${date}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secret_access_key}`, date), credentials.region), service),
    'aws4_request'
  );
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex');
}

describe('upstreamRequest with aws_bedrock credentials', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('signs bedrock-runtime requests for the bedrock service and sends no API key', async () => {
    const { url, headers, body } = await sendToBedrock(
      'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1'
    );

    expect(url).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions');
    expect(headers.has('x-api-key')).toBe(false);
    expect(headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);

    const authorization = parseAuthorization(headers.get('authorization') ?? '');
    expect(authorization).toMatchObject({
      accessKeyId: 'AKIDEXAMPLE',
      region: 'us-west-2',
      service: 'bedrock',
    });
    expect(authorization.signedHeaders).toEqual(
      expect.arrayContaining(['host', 'x-amz-date', 'x-definition-header'])
    );
    expect(authorization.signature).toBe(
      expectedSignature({
        url: new URL(url),
        headers,
        body,
        service: 'bedrock',
        signedHeaders: authorization.signedHeaders,
      })
    );
  });

  it('signs bedrock-mantle requests for the bedrock-mantle service', async () => {
    const { headers } = await sendToBedrock('https://bedrock-mantle.us-west-2.api.aws/v1');

    expect(parseAuthorization(headers.get('authorization') ?? '').service).toBe('bedrock-mantle');
  });
});
