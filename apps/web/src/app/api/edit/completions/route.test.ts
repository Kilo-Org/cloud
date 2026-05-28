import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';

jest.mock('@/lib/config.server', () => ({
  INCEPTION_API_KEY: 'system-inception-key',
}));
jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/ai-gateway/byok');
jest.mock('@/lib/debugUtils', () => ({
  debugSaveProxyRequest: jest.fn(),
  debugSaveProxyResponseStream: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    countAndStoreEditUsage: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedGetBYOKforOrganization = jest.mocked(getBYOKforOrganization);
const mockedGetBYOKforUser = jest.mocked(getBYOKforUser);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/edit/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function setOrganizationAuth(settings?: OrganizationSettings) {
  mockedGetUserFromAuth.mockResolvedValue({
    user: {
      id: 'user-123',
      google_user_email: 'test@example.com',
      microdollars_used: 0,
    } as User,
    authFailedResponse: null,
    organizationId: 'org-123',
  });
  mockedGetBalanceAndOrgSettings.mockResolvedValue({
    balance: 1000,
    settings,
    plan: 'teams',
  });
  mockedGetBYOKforOrganization.mockResolvedValue(null);
  mockedGetBYOKforUser.mockResolvedValue(null);
}

function makeValidRequestBody() {
  return {
    model: 'inception/mercury-edit-2',
    messages: [{ role: 'user', content: '<|code_to_edit|>const a = 1<|/code_to_edit|>' }],
    max_tokens: 100,
  };
}

function makeUpstreamResponse() {
  return new Response(JSON.stringify({ choices: [], model: 'mercury-edit-2' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/edit/completions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects direct Inception requests when organization data collection is denied', async () => {
    setOrganizationAuth({ data_collection: 'deny' } satisfies OrganizationSettings);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.data_collection_required,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [{ role: 'system', content: 'Do not forward system prompts' }] },
    { messages: [{ role: 'assistant', content: 'Do not forward assistant content' }] },
    {
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ],
    },
  ])('rejects unsupported edit messages before proxying', async ({ messages }) => {
    setOrganizationAuth();

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ ...makeValidRequestBody(), messages }) as never);

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('forwards a single user message to Inception', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const requestBody = makeValidRequestBody();
    const response = await POST(makeRequest(requestBody) as never);

    expect(response.status).toBe(200);
    const [, init] = mockedFetch.mock.calls[0];
    const upstreamBody = JSON.parse(init?.body as string);
    expect(upstreamBody.messages).toEqual(requestBody.messages);
  });
});
