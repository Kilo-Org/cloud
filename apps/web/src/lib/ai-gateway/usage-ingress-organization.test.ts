import { afterEach, beforeEach, expect, test } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {}, readDb: {} }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));
jest.mock('@kilocode/worker-utils/account-access', () => ({
  ...jest.requireActual<object>('@kilocode/worker-utils/account-access'),
  isOrganizationMember: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  getBlacklistedDomains: async () => [],
}));
jest.mock('@kilocode/web-shared/lib/posthog', () => ({
  __esModule: true,
  default: () => ({ capture() {} }),
}));
jest.mock('next-auth', () => ({
  ...jest.requireActual<object>('next-auth'),
  getServerSession: async () => null,
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-auth-secret',
  USAGE_INGEST_URL: 'https://synthetic.invalid/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-secret',
}));

import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import jwt from 'jsonwebtoken';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isOrganizationMember } from '@kilocode/worker-utils/account-access';
import { ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import {
  extractUsageContextInfo,
  toInsertableDbUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { resolveGatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { enqueueUsage } from '@kilocode/web-shared/lib/ai-gateway/usage-publisher';

const organizationId = '12345678-1234-4234-8234-123456789abc';
const user = {
  id: 'oauth/synthetic',
  google_user_email: 'synthetic@example.invalid',
  blocked_reason: null,
  api_token_pepper: null,
  is_admin: false,
} as User;
const send = jest
  .fn<Promise<void>, [UsageRecordRequest, { contentType: 'json' }]>()
  .mockResolvedValue(undefined);
// Load the actual Worker handler without importing its runtime globals into the Next.js typecheck.
const { handleFetch } = jest.requireActual<{
  handleFetch: (
    request: Request,
    env: { USAGE_INGEST_PUBLISH_SECRET: string; USAGE_INGEST_QUEUE: { send: typeof send } }
  ) => Promise<Response>;
}>('../../../../../services/usage-ingest/src/publish-usage');
const provider = jest.fn();
const context: MicrodollarUsageContext = {
  api_kind: 'chat_completions',
  kiloUserId: user.id,
  usageId: '12345678-1234-4234-8234-123456789ab1',
  provider: 'openrouter',
  requested_model: 'synthetic',
  fraudHeaders: {
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    http_user_agent: null,
  },
  promptInfo: {
    user_prompt_prefix: 'synthetic',
    system_prompt_prefix: '',
    system_prompt_length: 0,
  },
  is_free: false,
  custom_llm_pricing: null,
  max_tokens: null,
  has_middle_out_transform: null,
  isStreaming: false,
  prior_microdollar_usage: 0,
  project_id: null,
  status_code: 200,
  editor_name: null,
  machine_id: null,
  user_byok: false,
  has_tools: false,
  feature: null,
  session_id: null,
  mode: null,
  auto_model: null,
  reasoning_setting: null,
  inference_region: null,
  ttfb_ms: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(findUserById).mockResolvedValue(user);
  jest.mocked(isOrganizationMember).mockResolvedValue(true);
  send.mockClear();
  provider.mockClear();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
    handleFetch(new Request(String(url), init), {
      USAGE_INGEST_PUBLISH_SECRET: 'synthetic-secret',
      USAGE_INGEST_QUEUE: { send },
    })
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function authenticateThenPublish(
  header: string | undefined,
  signedOrganization?: string,
  validToken = true,
  allowAnonymous = false,
  extraClaims: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
) {
  const token = jwt.sign(
    { ...extraClaims, kiloUserId: user.id, version: 3, organizationId: signedOrganization },
    validToken ? 'synthetic-auth-secret' : 'wrong-synthetic-secret',
    { algorithm: 'HS256', expiresIn: 60 }
  );
  const headers = new Headers({ ...extraHeaders, Authorization: `Bearer ${token}` });
  if (header !== undefined) headers.set(ORGANIZATION_ID_HEADER, header);
  const auth = await getUserFromAuth({ adminOnly: false, requestHeaders: headers });
  const caller = resolveGatewayCaller(auth, { allowAnonymous, ipAddress: '192.0.2.1' });
  if (caller.kind === 'rejected') return { auth, caller, publication: undefined };
  provider();
  if (caller.kind === 'anonymous') return { auth, caller, publication: undefined };
  const record = await toInsertableDbUsageRecord(
    {
      cost_mUsd: 123,
      inputTokens: 10,
      outputTokens: 2,
      cacheWriteTokens: 0,
      cacheHitTokens: 0,
      messageId: 'synthetic',
      model: 'synthetic',
      hasError: false,
      responseContent: '',
      inference_provider: 'synthetic',
      upstream_id: null,
      finish_reason: 'stop',
      latency: null,
      moderation_latency: null,
      generation_time: null,
      is_byok: false,
      streamed: false,
      cancelled: false,
      status_code: 200,
    },
    extractUsageContextInfo({ ...context, organizationId: caller.organizationId })
  );
  const publication = await enqueueUsage({
    ...record,
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
  });
  return { auth, caller, publication };
}

test.each(['', ' ', 'not-an-organization-id'])(
  'rejects malformed organization context before inference: %j',
  async header => {
    const result = await authenticateThenPublish(header);
    expect(result.auth.authFailedResponse?.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(isOrganizationMember).not.toHaveBeenCalled();
  }
);

test.each([undefined, organizationId])(
  'preserves payer through producer, HTTP serialization and ingress: %s',
  async header => {
    const result = await authenticateThenPublish(header);
    expect(result.auth.authFailedResponse).toBeNull();
    expect(result.publication).toEqual({ kind: 'accepted' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      core: {
        id: context.usageId,
        organization_id: header ?? null,
        kilo_user_id: user.id,
        cost: 123,
      },
      metadata: { user_prompt_prefix: header ? null : 'synthetic' },
    });
    if (header)
      expect(isOrganizationMember).toHaveBeenCalledWith(expect.anything(), header, user.id);
    else expect(isOrganizationMember).not.toHaveBeenCalled();
  }
);

test('a valid organization ID still requires membership', async () => {
  jest.mocked(isOrganizationMember).mockResolvedValue(false);
  const result = await authenticateThenPublish(organizationId);
  expect(result.auth.authFailedResponse?.status).toBe(403);
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('a signed organization takes precedence over an empty mutable header', async () => {
  const result = await authenticateThenPublish('', organizationId);
  expect(result.publication).toEqual({ kind: 'accepted' });
  expect(send.mock.calls[0][0]).toMatchObject({ core: { organization_id: organizationId } });
  expect(isOrganizationMember).toHaveBeenCalledWith(expect.anything(), organizationId, user.id);
});

test('an empty signed organization cannot downgrade to a valid header or personal context', async () => {
  const result = await authenticateThenPublish(organizationId, '');
  expect(result.auth.authFailedResponse?.status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('invalid credentials retain precedence over malformed organization context', async () => {
  const result = await authenticateThenPublish('', undefined, false);
  expect(result.auth.authFailedResponse?.status).toBe(401);
  expect(findUserById).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('blocked accounts retain precedence over malformed organization context', async () => {
  jest.mocked(findUserById).mockResolvedValue({ ...user, blocked_reason: 'synthetic-block' });
  const result = await authenticateThenPublish('');
  expect(result.auth.authFailedResponse?.status).toBe(403);
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('a signed organization is retained when the mutable header is absent', async () => {
  const result = await authenticateThenPublish(undefined, organizationId);
  expect(result.publication).toEqual({ kind: 'accepted' });
  expect(send.mock.calls[0][0]).toMatchObject({ core: { organization_id: organizationId } });
  expect(isOrganizationMember).toHaveBeenCalledWith(expect.anything(), organizationId, user.id);
});

test('ingress still rejects a malformed organization identity without enqueueing', async () => {
  await authenticateThenPublish(organizationId);
  const [payload] = send.mock.calls[0];
  send.mockClear();
  const response = await handleFetch(
    new Request('https://synthetic.invalid/usage', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, core: { ...payload.core, organization_id: '' } }),
    }),
    { USAGE_INGEST_PUBLISH_SECRET: 'synthetic-secret', USAGE_INGEST_QUEUE: { send } }
  );
  expect(response.status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

// These are the actual caller-admission options used by the two free-capable handlers.
test.each([
  { route: 'llm-proxy free', allowAnonymous: true },
  { route: 'llm-proxy paid', allowAnonymous: true },
  { route: 'embeddings free', allowAnonymous: true },
  { route: 'embeddings paid', allowAnonymous: false },
])('preserves the empty-organization 400 at $route admission', async ({ allowAnonymous }) => {
  const result = await authenticateThenPublish('', undefined, true, allowAnonymous);
  expect(result.caller.kind).toBe('rejected');
  if (result.caller.kind !== 'rejected') return;
  expect(result.caller.response.status).toBe(400);
  expect(result.caller.response === result.auth.authFailedResponse).toBe(true);
  await expect(result.caller.response.json()).resolves.toEqual({
    success: false,
    error: 'Invalid organization ID format',
  });
  expect(provider).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('unrelated nonempty malformed organization context retains baseline anonymous policy', async () => {
  const result = await authenticateThenPublish('not-a-uuid', undefined, true, true);
  expect(result.auth.authFailedResponse?.status).toBe(400);
  expect(result.caller.kind).toBe('anonymous');
});

test('a refused request is rejected during admission', async () => {
  jest.mocked(findUserById).mockResolvedValue({ ...user, blocked_reason: 'synthetic-block' });
  const result = await authenticateThenPublish('', undefined, true, true);
  expect(result.auth.authFailedResponse?.status).toBe(403);
  expect(result.auth.authorizationRefused).toBe(true);
  expect(result.caller.kind).toBe('rejected');
  if (result.caller.kind !== 'rejected') return;
  expect(result.caller.response).toBe(result.auth.authFailedResponse);
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('claim and header names cannot forge the internal rejection discriminator', async () => {
  const result = await authenticateThenPublish(
    undefined,
    undefined,
    true,
    true,
    {
      rejectionReason: 'empty_organization_context',
      credentialsRejected: false,
      authorizationRefused: false,
    },
    {
      rejectionReason: 'empty_organization_context',
      credentialsRejected: 'false',
      authorizationRefused: 'false',
    }
  );
  expect(result.auth).not.toHaveProperty('rejectionReason');
  expect(result.auth).not.toHaveProperty('authorizationRefused');
  expect(result.caller.kind).toBe('signed-in');
  expect(result.publication).toEqual({ kind: 'accepted' });
});

test.each([undefined, '', organizationId])(
  'empty signed context cannot downgrade during anonymous-capable admission: %j',
  async header => {
    const result = await authenticateThenPublish(header, '', true, true);
    expect(result.caller.kind).toBe('rejected');
    if (result.caller.kind !== 'rejected') return;
    expect(result.caller.response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
);

test('a supplied whitespace signed context retains the nonempty-invalid baseline policy', async () => {
  const result = await authenticateThenPublish(organizationId, ' ', true, true);
  expect(result.auth.authFailedResponse?.status).toBe(400);
  expect(result.auth).not.toHaveProperty('rejectionReason');
  expect(result.caller.kind).toBe('anonymous');
});

test('missing credentials retain anonymous access only when admission allows it', async () => {
  const auth = await getUserFromAuth({ adminOnly: false, requestHeaders: new Headers() });
  expect(auth).not.toHaveProperty('rejectionReason');
  expect(resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: '192.0.2.1' }).kind).toBe(
    'anonymous'
  );
  const paid = resolveGatewayCaller(auth, { allowAnonymous: false });
  expect(paid.kind).toBe('rejected');
  if (paid.kind === 'rejected') expect(paid.response.status).toBe(401);
});

test('forged rejection metadata cannot change invalid credential handling', async () => {
  const result = await authenticateThenPublish(
    undefined,
    undefined,
    false,
    true,
    { rejectionReason: 'empty_organization_context', credentialsRejected: false },
    { rejectionReason: 'empty_organization_context' }
  );
  expect(result.auth).not.toHaveProperty('rejectionReason');
  expect(result.caller.kind).toBe('rejected');
  if (result.caller.kind === 'rejected') expect(result.caller.response.status).toBe(401);
  expect(provider).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
