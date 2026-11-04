import crypto from 'crypto';

/**
 * The shared jest config redirects `@/lib/integrations/platforms/github/adapter`
 * to an always-accepting stub. This suite needs the real verifier to exercise the
 * route's authentication gate, so it loads the adapter module by relative path and
 * re-registers it under the alias the handler imports.
 */
jest.mock('@/lib/integrations/platforms/github/adapter', () =>
  jest.requireActual('../../../../lib/integrations/platforms/github/adapter')
);

// The authenticated path must not need a database: an unknown installation is
// answered from the lookup's absence.
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findIntegrationByInstallationId: jest.fn(async () => null),
  findConnectedIntegrationByInstallationId: jest.fn(async () => null),
  getIntegrationForOrganization: jest.fn(async () => null),
}));

// Chat adapters are constructed at module scope; the delivery path under test
// never reaches them.
jest.mock('@/lib/bot', () => ({ bot: {} }));

import { POST } from './route';

const LITE_SECRET = 'lite-route-test-secret';
const PAYLOAD = JSON.stringify({ action: 'opened', installation: { id: 98765 } });

function signatureFor(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function liteRequest(signature: string | null, payload = PAYLOAD): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-delivery': 'delivery-lite-route',
    'x-github-event': 'pull_request',
  };
  if (signature !== null) {
    headers['x-hub-signature-256'] = signature;
  }
  return new Request('https://app.example.com/api/webhooks/github-lite', {
    method: 'POST',
    headers,
    body: payload,
  });
}

const ORIGINAL_LITE_SECRET = process.env.GITHUB_LITE_APP_WEBHOOK_SECRET;

afterEach(() => {
  if (ORIGINAL_LITE_SECRET === undefined) {
    delete process.env.GITHUB_LITE_APP_WEBHOOK_SECRET;
  } else {
    process.env.GITHUB_LITE_APP_WEBHOOK_SECRET = ORIGINAL_LITE_SECRET;
  }
});

describe('github-lite webhook route authentication', () => {
  it('refuses a request signed with an empty key when the app secret is not configured', async () => {
    delete process.env.GITHUB_LITE_APP_WEBHOOK_SECRET;

    const response = await POST(liteRequest(signatureFor(PAYLOAD, '')) as never);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('refuses a signature that does not match the configured secret', async () => {
    process.env.GITHUB_LITE_APP_WEBHOOK_SECRET = LITE_SECRET;

    const response = await POST(liteRequest(signatureFor(PAYLOAD, 'wrong-key')) as never);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('answers an unauthenticated caller the same way whether the secret is missing or the signature is wrong', async () => {
    delete process.env.GITHUB_LITE_APP_WEBHOOK_SECRET;
    const unconfigured = await POST(liteRequest(signatureFor(PAYLOAD, '')) as never);

    process.env.GITHUB_LITE_APP_WEBHOOK_SECRET = LITE_SECRET;
    const invalid = await POST(liteRequest(signatureFor(PAYLOAD, 'wrong-key')) as never);

    expect(unconfigured.status).toBe(invalid.status);
    expect(await unconfigured.text()).toBe(await invalid.text());
  });

  it('refuses a delivery that carries no signature header', async () => {
    process.env.GITHUB_LITE_APP_WEBHOOK_SECRET = LITE_SECRET;

    const response = await POST(liteRequest(null) as never);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('reaches the shared handler with a correctly signed delivery and keeps its response', async () => {
    process.env.GITHUB_LITE_APP_WEBHOOK_SECRET = LITE_SECRET;

    const response = await POST(liteRequest(signatureFor(PAYLOAD, LITE_SECRET)) as never);

    // Past the signature gate the handler answers the delivery itself: this
    // payload carries no row for the installation, so the handler reports it.
    expect(response.status).not.toBe(401);
    expect(await response.text()).toBe('{"message":"Integration not found"}');
  });
});
