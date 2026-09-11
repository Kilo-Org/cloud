import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const afterCallbacks: Array<() => Promise<void> | void> = [];
const mockMarkTerminal = jest.fn<Promise<boolean>, [unknown]>(async () => true);
const mockUpdateValues: Array<Record<string, unknown>> = [];
const mockBotInitialize = jest.fn();
const mockGetPlatformIntegration = jest.fn();
const mockStartProcessingIndicator = jest.fn();
let platformIntegrationId: string | null = '00000000-0000-4000-8000-000000000002';

class MockPlatformIntegrationUnavailableError extends Error {}

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: (callback: () => Promise<void> | void) => afterCallbacks.push(callback),
}));
jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
  INTERNAL_API_SECRET: '',
}));
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: '00000000-0000-4000-8000-000000000001',
              status: 'pending',
              created_at: '2026-09-07T00:00:00.000Z',
              cloud_agent_session_id: 'session-1',
              platform_integration_id: platformIntegrationId,
              platform_thread_id: 'github:thread',
              platform_message_id: 'message-1',
              platform: 'github',
              created_by: 'user-1',
              steps: [],
            },
          ],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mockUpdateValues.push(values);
        return { where: () => ({ returning: async () => [{ id: 'request-1' }] }) };
      },
    }),
  },
}));
jest.mock('@/lib/bot/cloud-agent-session-groups', () => ({
  getBotRequestCloudAgentSession: jest.fn(async () => ({
    cloud_agent_session_id: 'session-1',
    status: 'pending',
  })),
  getBotRequestCloudAgentSessionGroupReadiness: jest.fn(),
  claimBotRequestCloudAgentSessionGroupContinuation: jest.fn(),
}));
jest.mock('@/lib/bot/request-logging', () => ({
  markBotRequestCloudAgentSessionTerminalStrict: (input: unknown) => mockMarkTerminal(input),
  recordBotRequestCloudAgentSessionResultErrorStrict: jest.fn(),
  recordBotRequestCloudAgentSessionResultStrict: jest.fn(),
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  PlatformIntegrationUnavailableError: MockPlatformIntegrationUnavailableError,
  PlatformIntegrationNotFoundError: class PlatformIntegrationNotFoundError extends Error {},
  getPlatformIntegrationById: (...args: unknown[]) => mockGetPlatformIntegration(...args),
}));
jest.mock('@/lib/bot', () => ({
  bot: { initialize: mockBotInitialize, thread: jest.fn(() => ({ id: 'thread' })) },
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: () => ({
      withAuthContext: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
      startProcessingIndicator: (...args: unknown[]) => mockStartProcessingIndicator(...args),
    }),
  },
}));
jest.mock('@/lib/bot/agent-runner', () => ({ runBotAgent: jest.fn() }));
jest.mock('@/lib/user', () => ({ findUserById: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';

beforeEach(() => {
  afterCallbacks.length = 0;
  mockUpdateValues.length = 0;
  mockMarkTerminal.mockClear();
  mockBotInitialize.mockClear();
  platformIntegrationId = '00000000-0000-4000-8000-000000000002';
  mockGetPlatformIntegration.mockRejectedValue(
    new MockPlatformIntegrationUnavailableError('disconnected')
  );
  mockStartProcessingIndicator.mockResolvedValue(async () => {});
});

test('persists terminal callback state and finalizes without publishing after disconnect', async () => {
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest(`http://localhost/callback?currentStep=1`, {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      cloudAgentSessionId: 'session-1',
      executionId: 'execution-1',
      lastAssistantMessageText: 'finished',
    }),
  });
  const { POST } = await import('./route');
  const response = await POST(request, { params: Promise.resolve({ botRequestId }) });
  expect(response.status).toBe(200);
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalledWith(
    expect.objectContaining({ cloudAgentSessionId: 'session-1', status: 'completed' })
  );
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was disconnected before callback publication.',
    })
  );
  expect(mockBotInitialize).not.toHaveBeenCalled();
});

test('finalizes when disconnect is detected by the processing indicator after healthy lookup', async () => {
  mockGetPlatformIntegration.mockResolvedValue({
    id: platformIntegrationId,
    platform: 'github',
  });
  mockStartProcessingIndicator.mockRejectedValue(new GitHubRuntimeAuthorizationError());
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest('http://localhost/callback?currentStep=1', {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', cloudAgentSessionId: 'session-1' }),
  });
  const { POST } = await import('./route');
  await POST(request, { params: Promise.resolve({ botRequestId }) });
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalled();
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was disconnected before callback publication.',
    })
  );
});

test('finalizes without publishing when the integration was deleted before callback', async () => {
  platformIntegrationId = null;
  const botRequestId = '00000000-0000-4000-8000-000000000001';
  const token = createHmac('sha256', 'callback-secret')
    .update(`bot-callback:${botRequestId}`)
    .digest('hex');
  const request = new NextRequest('http://localhost/callback?currentStep=1', {
    method: 'POST',
    headers: { 'X-Bot-Callback-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'failed', cloudAgentSessionId: 'session-1' }),
  });
  const { POST } = await import('./route');
  const response = await POST(request, { params: Promise.resolve({ botRequestId }) });
  expect(response.status).toBe(200);
  await Promise.all(afterCallbacks.splice(0).map(callback => callback()));
  expect(mockMarkTerminal).toHaveBeenCalled();
  expect(mockUpdateValues).toContainEqual(
    expect.objectContaining({
      status: 'error',
      error_message: 'Platform connection was removed before callback publication.',
    })
  );
  expect(mockBotInitialize).not.toHaveBeenCalled();
});
