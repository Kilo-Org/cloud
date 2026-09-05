const appBuilderServiceMocks = {
  createProject: jest.fn(),
  getProject: jest.fn(),
  interruptSession: jest.fn(),
  startSessionForProject: jest.fn(),
  sendMessage: jest.fn(),
};

const mockCreateControlTokenForRequest = jest.fn();

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: (...args: unknown[]) => mockCreateControlTokenForRequest(...args),
}));

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));

jest.mock('@/lib/app-builder/app-builder-service', () => ({
  createProject: (...args: unknown[]) => appBuilderServiceMocks.createProject(...args),
  getProject: (...args: unknown[]) => appBuilderServiceMocks.getProject(...args),
  interruptSession: (...args: unknown[]) => appBuilderServiceMocks.interruptSession(...args),
  startSessionForProject: (...args: unknown[]) =>
    appBuilderServiceMocks.startSessionForProject(...args),
  sendMessage: (...args: unknown[]) => appBuilderServiceMocks.sendMessage(...args),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { organizations, organization_memberships } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { Owner } from '@/lib/integrations/core/types';
import type { User } from '@kilocode/db/schema';

const projectId = '00000000-0000-4000-8000-000000000001';
const message = 'Build a weather app';

type CapturedAuthToken = { owner: Owner; token: string };

function mockAppBuilderService(): void {
  appBuilderServiceMocks.createProject.mockResolvedValue({ projectId });
  appBuilderServiceMocks.getProject.mockResolvedValue({});
  appBuilderServiceMocks.interruptSession.mockResolvedValue({ success: true });
  appBuilderServiceMocks.startSessionForProject.mockResolvedValue({
    cloudAgentSessionId: 'session-1',
  });
  appBuilderServiceMocks.sendMessage.mockResolvedValue({
    cloudAgentSessionId: 'session-1',
    workerVersion: 'v2',
  });
}

async function invokePersonalAppBuilderMethods(
  caller: Awaited<ReturnType<typeof createCallerForUser>>
): Promise<void> {
  await caller.appBuilder.createProject({
    prompt: message,
    model: 'test-model',
    images: undefined,
  });
  await caller.appBuilder.getProject({ projectId });
  await caller.appBuilder.interruptSession({ projectId });
  await caller.appBuilder.startSession({ projectId });
  await caller.appBuilder.sendMessage({ projectId, message, images: undefined });
}

async function invokeOrganizationAppBuilderMethods(
  caller: Awaited<ReturnType<typeof createCallerForUser>>,
  organizationId: string
): Promise<void> {
  await caller.organizations.appBuilder.createProject({
    organizationId,
    prompt: message,
    model: 'test-model',
    images: undefined,
  });
  await caller.organizations.appBuilder.getProject({ organizationId, projectId });
  await caller.organizations.appBuilder.interruptSession({ organizationId, projectId });
  await caller.organizations.appBuilder.startSession({ organizationId, projectId });
  await caller.organizations.appBuilder.sendMessage({
    organizationId,
    projectId,
    message,
    images: undefined,
  });
}

function capturedAuthTokens(): CapturedAuthToken[] {
  return [
    ...appBuilderServiceMocks.createProject.mock.calls.map(([options]) => ({
      owner: options.owner as Owner,
      token: options.authToken as string,
    })),
    ...appBuilderServiceMocks.getProject.mock.calls.map(([, owner, token]) => ({
      owner: owner as Owner,
      token: token as string,
    })),
    ...appBuilderServiceMocks.interruptSession.mock.calls.map(([, owner, token]) => ({
      owner: owner as Owner,
      token: token as string,
    })),
    ...appBuilderServiceMocks.startSessionForProject.mock.calls.map(([options]) => ({
      owner: options.owner as Owner,
      token: options.authToken as string,
    })),
    ...appBuilderServiceMocks.sendMessage.mock.calls.map(([options]) => ({
      owner: options.owner as Owner,
      token: options.authToken as string,
    })),
  ];
}

describe('App Builder system tokens', () => {
  let user: User;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCreateControlTokenForRequest.mockImplementation(
      async (currentUser: User, _resource: string, options?: { organizationId?: string }) => ({
        token: `app-builder-token-${options?.organizationId ?? 'personal'}`,
        user: currentUser,
      })
    );
    mockAppBuilderService();
    user = await insertTestUser({ api_token_pepper: 'app-builder-token-source-pepper' });
  });

  it('forwards verified request-derived app-builder tokens for personal and organization operations', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({
        name: `App Builder ${crypto.randomUUID()}`,
        created_by_kilo_user_id: user.id,
        require_seats: false,
      })
      .returning();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: user.id,
      role: 'member',
    });
    const caller = await createCallerForUser(user.id);

    await invokePersonalAppBuilderMethods(caller);
    await invokeOrganizationAppBuilderMethods(caller, organization.id);

    for (const mock of Object.values(appBuilderServiceMocks)) {
      expect(mock).toHaveBeenCalledTimes(2);
    }

    const tokens = capturedAuthTokens();
    expect(tokens).toHaveLength(10);
    expect(tokens.map(({ owner }) => owner)).toEqual([
      { type: 'user', id: user.id },
      { type: 'org', id: organization.id },
      { type: 'user', id: user.id },
      { type: 'org', id: organization.id },
      { type: 'user', id: user.id },
      { type: 'org', id: organization.id },
      { type: 'user', id: user.id },
      { type: 'org', id: organization.id },
      { type: 'user', id: user.id },
      { type: 'org', id: organization.id },
    ]);

    expect(tokens.map(({ token }) => token)).toEqual([
      'app-builder-token-personal',
      `app-builder-token-${organization.id}`,
      'app-builder-token-personal',
      `app-builder-token-${organization.id}`,
      'app-builder-token-personal',
      `app-builder-token-${organization.id}`,
      'app-builder-token-personal',
      `app-builder-token-${organization.id}`,
      'app-builder-token-personal',
      `app-builder-token-${organization.id}`,
    ]);
    expect(mockCreateControlTokenForRequest).toHaveBeenCalledTimes(10);
    for (const [, resource, options] of mockCreateControlTokenForRequest.mock.calls) {
      expect(resource).toBe('cloud-agent-next');
      expect(options).toMatchObject({ tokenSource: 'app-builder' });
    }
  });
});
