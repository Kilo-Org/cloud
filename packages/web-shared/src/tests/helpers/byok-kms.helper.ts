import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { readJsonBody } from './request-body.helper';

export const TEST_BYOK_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
const TEST_KMS_URL = 'http://byok-kms.test';

export function testByokEnvelope(
  secret: string,
  dataKey: string = TEST_BYOK_DATA_KEY
): BYOKApiKeyEnvelope {
  return {
    encrypted_data: encryptApiKey(secret, dataKey),
    wrapped_dek: 'wrapped',
    kms_key_id: 'alias/test',
    kms_key_version: '1',
    algorithm: 'aes-256-gcm',
    envelope_version: 1,
  };
}

export type FakeByokKmsPath = '/data-key' | '/decrypt';

export type FakeByokKms = {
  requests: FakeByokKmsRequest[];
  /** Answers every request to `path` with `status` for the rest of the test. */
  fail: (path: FakeByokKmsPath, status?: number) => void;
};

export type FakeByokKmsRequest = { path: string; body: Record<string, unknown> };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body the BYOK KMS client sends is a JSON object; anything else is a broken fixture. */
function requestBodyObject(body: BodyInit | null | undefined): Record<string, unknown> {
  const parsed = readJsonBody(body ?? '{}');
  if (!isJsonObject(parsed)) throw new Error('Expected the BYOK KMS request body to be an object');
  return parsed;
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

export function isFakeByokKmsRequest(input: RequestInfo | URL): boolean {
  try {
    return requestUrl(input).origin === TEST_KMS_URL;
  } catch {
    return false;
  }
}

/**
 * Points the BYOK KMS client at an in-process fake for each test. Every data key it issues or
 * returns is `TEST_BYOK_DATA_KEY`, so rows built with `testByokEnvelope` decrypt without
 * further setup. Other fetches pass through untouched.
 */
export function useFakeByokKms(): FakeByokKms {
  const fake = createFakeByokKms();
  beforeEach(fake.install);
  afterEach(fake.uninstall);
  return fake.kms;
}

/**
 * Like `useFakeByokKms`, but installed once for the whole suite so `beforeAll` setup can
 * seal credentials too. Recorded requests and forced failures still reset before each test.
 */
export function useFakeByokKmsForSuite(): FakeByokKms {
  const fake = createFakeByokKms();
  beforeAll(fake.install);
  afterAll(fake.uninstall);
  beforeEach(fake.reset);
  return fake.kms;
}

function createFakeByokKms() {
  const requests: FakeByokKmsRequest[] = [];
  const failures = new Map<string, number>();
  const originalFetch = global.fetch;
  const originalUrl = process.env.BYOK_KMS_SERVICE_URL;
  const originalToken = process.env.BYOK_KMS_SERVICE_TOKEN;

  function reset() {
    requests.length = 0;
    failures.clear();
  }

  function install() {
    reset();
    process.env.BYOK_KMS_SERVICE_URL = TEST_KMS_URL;
    process.env.BYOK_KMS_SERVICE_TOKEN = 'test-token';
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isFakeByokKmsRequest(input)) return originalFetch(input, init);
      const url = requestUrl(input);
      requests.push({ path: url.pathname, body: requestBodyObject(init?.body) });
      const failure = failures.get(url.pathname);
      if (failure !== undefined) return new Response('{}', { status: failure });
      if (url.pathname === '/data-key') {
        return Response.json({
          data_key: TEST_BYOK_DATA_KEY,
          wrapped_dek: 'wrapped',
          kms_key_id: 'alias/test',
          kms_key_version: '1',
        });
      }
      if (url.pathname === '/decrypt') return Response.json({ data_key: TEST_BYOK_DATA_KEY });
      return new Response('{}', { status: 404 });
    };
  }

  function uninstall() {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.BYOK_KMS_SERVICE_URL;
    else process.env.BYOK_KMS_SERVICE_URL = originalUrl;
    if (originalToken === undefined) delete process.env.BYOK_KMS_SERVICE_TOKEN;
    else process.env.BYOK_KMS_SERVICE_TOKEN = originalToken;
  }

  const kms: FakeByokKms = {
    requests,
    fail: (path, status = 403) => {
      failures.set(path, status);
    },
  };
  return { kms, install, uninstall, reset };
}

/**
 * A fetch that sends requests whose URL starts with `upstreamUrlPrefix` to `upstreamFetch`
 * and everything else, including the BYOK KMS and the data key cache, to the fetch that was
 * installed when it was called. Call it inside a `beforeEach` that runs after
 * `useFakeByokKms`, so a test that mocks an upstream keeps the KMS fake, and its mock sees
 * only upstream calls.
 */
export function fetchWithFakeByokKms(
  upstreamUrlPrefix: string,
  upstreamFetch: typeof fetch
): typeof fetch {
  const defaultFetch = global.fetch;
  return (input, init) =>
    requestUrl(input).href.startsWith(upstreamUrlPrefix)
      ? upstreamFetch(input, init)
      : defaultFetch(input, init);
}
