import type { BYOKApiKeyEnvelope } from '@kilocode/db/schema-types';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';

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

export type FakeByokKmsRequest = { path: string; body: Record<string, unknown> };

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
export function useFakeByokKms(): { requests: FakeByokKmsRequest[] } {
  const requests: FakeByokKmsRequest[] = [];
  const originalFetch = global.fetch;
  const originalUrl = process.env.BYOK_KMS_SERVICE_URL;
  const originalToken = process.env.BYOK_KMS_SERVICE_TOKEN;

  beforeEach(() => {
    requests.length = 0;
    process.env.BYOK_KMS_SERVICE_URL = TEST_KMS_URL;
    process.env.BYOK_KMS_SERVICE_TOKEN = 'test-token';
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isFakeByokKmsRequest(input)) return originalFetch(input, init);
      const url = requestUrl(input);
      requests.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) });
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
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.BYOK_KMS_SERVICE_URL;
    else process.env.BYOK_KMS_SERVICE_URL = originalUrl;
    if (originalToken === undefined) delete process.env.BYOK_KMS_SERVICE_TOKEN;
    else process.env.BYOK_KMS_SERVICE_TOKEN = originalToken;
  });

  return { requests };
}
