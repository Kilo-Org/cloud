import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeUserIdForPath } from '../util/user-id-encoding';

vi.mock('../util/do-retry', () => ({
  withDORetry: async <TStub, TResult>(
    getStub: () => TStub,
    operation: (stub: TStub) => Promise<TResult>
  ): Promise<TResult> => operation(getStub()),
}));

import { api, TriggerConfigInput, TriggerConfigUpdateInput } from './api';

describe('trigger variant validation', () => {
  const createInput = {
    githubRepo: 'owner/repo',
    mode: 'code',
    model: 'openai/gpt-4.1',
    promptTemplate: 'Process {{body}}',
    profileId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
  };

  it('accepts an omitted or alphabetic variant up to 50 characters on create', () => {
    expect(TriggerConfigInput.safeParse(createInput).success).toBe(true);
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'a'.repeat(50) }).success).toBe(
      true
    );
  });

  it('rejects non-alphabetic and oversized create variants', () => {
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'high-effort' }).success).toBe(
      false
    );
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'a'.repeat(51) }).success).toBe(
      false
    );
  });

  it('accepts null to clear a variant on update and rejects invalid values', () => {
    expect(TriggerConfigUpdateInput.safeParse({ variant: null }).success).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ variant: 'medium' }).success).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ variant: 'medium-1' }).success).toBe(false);
  });
});

describe('trigger sandbox allocation validation', () => {
  const cloudAgentInput = {
    githubRepo: 'owner/repo',
    mode: 'code',
    model: 'openai/gpt-4.1',
    promptTemplate: 'Process {{body}}',
    profileId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
  };

  const kiloclawInput = {
    targetType: 'kiloclaw_chat' as const,
    kiloclawInstanceId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
    promptTemplate: 'Process {{body}}',
  };

  it('defaults target and activation modes while accepting cloud allocation', () => {
    const result = TriggerConfigInput.parse({
      ...cloudAgentInput,
      sandboxAllocation: 'isolated-standard',
    });

    expect(result.targetType).toBe('cloud_agent');
    expect(result.activationMode).toBe('webhook');
    expect(result.sandboxAllocation).toBe('isolated-standard');
  });

  it.each([
    { activationMode: 'webhook' as const },
    { activationMode: 'scheduled' as const, cronExpression: '* * * * *' },
  ])('accepts allocation for $activationMode cloud triggers', input => {
    expect(
      TriggerConfigInput.safeParse({
        ...cloudAgentInput,
        ...input,
        sandboxAllocation: 'isolated-standard',
      }).success
    ).toBe(true);
  });

  it('rejects invalid or null create allocation values', () => {
    expect(
      TriggerConfigInput.safeParse({ ...cloudAgentInput, sandboxAllocation: 'standard' }).success
    ).toBe(false);
    expect(
      TriggerConfigInput.safeParse({ ...cloudAgentInput, sandboxAllocation: null }).success
    ).toBe(false);
  });

  it.each([
    { activationMode: 'webhook' as const },
    { activationMode: 'scheduled' as const, cronExpression: '* * * * *' },
  ])('rejects allocation for $activationMode KiloClaw triggers', input => {
    expect(
      TriggerConfigInput.safeParse({
        ...kiloclawInput,
        ...input,
        sandboxAllocation: 'isolated-standard',
      }).success
    ).toBe(false);
  });

  it('accepts allocation updates and null clears while rejecting invalid values', () => {
    expect(
      TriggerConfigUpdateInput.safeParse({ sandboxAllocation: 'isolated-standard' }).success
    ).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ sandboxAllocation: null }).success).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ sandboxAllocation: 'standard' }).success).toBe(
      false
    );
  });
});

const INTERNAL_API_SECRET = 'test-internal-secret';
const NAMESPACE = 'user/user-1';
const TRIGGER_ID = 'trigger-1';

type StoredConfig = {
  targetType: 'cloud_agent' | 'kiloclaw_chat';
  activationMode: string;
  sandboxAllocation?: 'isolated-standard';
};

type ScheduledInvocation = { success: true; requestId: string } | { success: false; error: string };

function existingConfig(
  targetType: StoredConfig['targetType'],
  activationMode = 'webhook',
  sandboxAllocation?: StoredConfig['sandboxAllocation']
): StoredConfig {
  return {
    targetType,
    activationMode,
    ...(sandboxAllocation ? { sandboxAllocation } : {}),
  };
}

function createRouteHarness(initialConfig: StoredConfig | null) {
  const config = initialConfig;
  const configure = vi.fn(async () => ({ success: true }));
  const getConfig = vi.fn(async () => config);
  const updateConfig = vi.fn(
    async (updates: { sandboxAllocation?: 'isolated-standard' | null }) => {
      if (config && updates.sandboxAllocation !== undefined) {
        if (updates.sandboxAllocation === null) {
          delete config.sandboxAllocation;
        } else {
          config.sandboxAllocation = updates.sandboxAllocation;
        }
      }
      return { success: true };
    }
  );
  const getConfigForResponse = vi.fn(async () => config);
  const idFromName = vi.fn((name: string) => name);
  const invokeScheduled = vi.fn(
    async (): Promise<ScheduledInvocation> => ({ success: true, requestId: crypto.randomUUID() })
  );
  const stub = { configure, getConfig, updateConfig, getConfigForResponse, invokeScheduled };
  const env = {
    INTERNAL_API_SECRET: { get: vi.fn(async () => INTERNAL_API_SECRET) },
    TRIGGER_DO: {
      idFromName,
      get: vi.fn(() => stub),
    },
  } as unknown as Env;

  return {
    configure,
    env,
    getConfig,
    getConfigForResponse,
    idFromName,
    invokeScheduled,
    updateConfig,
  };
}

async function requestTrigger(env: Env, method: 'POST' | 'PUT', payload: Record<string, unknown>) {
  return api.request(
    `/triggers/user/user-1/${TRIGGER_ID}`,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(payload),
    },
    env
  );
}

describe('trigger sandbox allocation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { activationMode: 'webhook', extra: {} },
    { activationMode: 'scheduled', extra: { cronExpression: '* * * * *' } },
  ])(
    'passes allocation through for $activationMode trigger creation',
    async ({ activationMode, extra }) => {
      const { configure, env } = createRouteHarness(null);

      const response = await requestTrigger(env, 'POST', {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process {{body}}',
        profileId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
        activationMode,
        sandboxAllocation: 'isolated-standard',
        ...extra,
      });

      expect(response.status).toBe(201);
      expect(configure).toHaveBeenCalledWith(
        NAMESPACE,
        TRIGGER_ID,
        expect.objectContaining({ sandboxAllocation: 'isolated-standard' })
      );
    }
  );

  it('rejects KiloClaw allocation before configuring a trigger', async () => {
    const { configure, env } = createRouteHarness(null);

    const response = await requestTrigger(env, 'POST', {
      targetType: 'kiloclaw_chat',
      kiloclawInstanceId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
      promptTemplate: 'Process {{body}}',
      sandboxAllocation: 'isolated-standard',
    });

    expect(response.status).toBe(400);
    expect(configure).not.toHaveBeenCalled();
  });

  it.each([
    { payload: { sandboxAllocation: 'isolated-standard' } },
    {
      payload: {
        sandboxAllocation: null,
        targetType: 'cloud_agent',
        activationMode: 'scheduled',
      },
    },
  ])('rejects KiloClaw allocation based on stored target configuration', async ({ payload }) => {
    const { env, updateConfig } = createRouteHarness(existingConfig('kiloclaw_chat'));

    const response = await requestTrigger(env, 'PUT', payload);

    expect(response.status).toBe(400);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('returns 404 before target validation for an unknown trigger', async () => {
    const { env, updateConfig } = createRouteHarness(null);

    const response = await requestTrigger(env, 'PUT', { sandboxAllocation: null });

    expect(response.status).toBe(404);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('allows unrelated KiloClaw updates', async () => {
    const { env, updateConfig } = createRouteHarness(existingConfig('kiloclaw_chat'));

    const response = await requestTrigger(env, 'PUT', { isActive: false });

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith({ isActive: false });
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body).toMatchObject({ data: { targetType: 'kiloclaw_chat' } });
    expect(body.data).not.toHaveProperty('sandboxAllocation');
  });

  it.each([
    { activationMode: 'webhook', sandboxAllocation: 'isolated-standard' as const },
    { activationMode: 'webhook', sandboxAllocation: null },
    { activationMode: 'scheduled', sandboxAllocation: 'isolated-standard' as const },
    { activationMode: 'scheduled', sandboxAllocation: null },
  ])('updates allocation for stored $activationMode cloud triggers', async updates => {
    const { env, updateConfig } = createRouteHarness(
      existingConfig('cloud_agent', updates.activationMode, 'isolated-standard')
    );

    const response = await requestTrigger(env, 'PUT', updates);

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith({ sandboxAllocation: updates.sandboxAllocation });
    const body = (await response.json()) as { data: Record<string, unknown> };
    if (updates.sandboxAllocation === null) {
      expect(body).toMatchObject({ data: {} });
      expect(body.data).not.toHaveProperty('sandboxAllocation');
    } else {
      expect(body).toMatchObject({ data: { sandboxAllocation: 'isolated-standard' } });
    }
  });
});

describe('scheduled trigger invocation routes', () => {
  it('uses the decoded OAuth namespace and invokes without accepting configuration', async () => {
    const oauthUserId = 'oauth/google:101043560986948156510';
    const { env, idFromName, invokeScheduled } = createRouteHarness(null);

    const response = await api.request(
      `/triggers/user/${encodeUserIdForPath(oauthUserId)}/${TRIGGER_ID}/invoke`,
      { method: 'POST', headers: { 'X-Internal-API-Key': INTERNAL_API_SECRET } },
      env
    );

    expect(response.status).toBe(202);
    expect(invokeScheduled).toHaveBeenCalledOnce();
    expect(idFromName).toHaveBeenCalledWith(`user/${oauthUserId}/${TRIGGER_ID}`);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { requestId: expect.any(String) },
    });
  });

  it.each([
    ['NOT_FOUND', 404],
    ['NOT_SCHEDULED', 400],
    ['INACTIVE', 409],
    ['INFLIGHT_LIMIT', 429],
    ['QUEUE_FAILED', 500],
  ] as const)('maps %s invocation failures to %i', async (error, status) => {
    const { env, invokeScheduled } = createRouteHarness(null);
    invokeScheduled.mockResolvedValue({ success: false, error });

    const response = await api.request(
      `/triggers/org/org-1/${TRIGGER_ID}/invoke`,
      {
        method: 'POST',
        headers: { 'X-Internal-API-Key': INTERNAL_API_SECRET },
      },
      env
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, error });
  });

  it('requires the internal API key', async () => {
    const { env, invokeScheduled } = createRouteHarness(null);
    const response = await api.request(
      `/triggers/org/org-1/${TRIGGER_ID}/invoke`,
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(401);
    expect(invokeScheduled).not.toHaveBeenCalled();
  });

  it('does not retry a retryable invocation error', async () => {
    const { env, invokeScheduled } = createRouteHarness(null);
    invokeScheduled.mockRejectedValue(Object.assign(new Error('retryable'), { retryable: true }));

    const response = await api.request(
      `/triggers/org/org-1/${TRIGGER_ID}/invoke`,
      { method: 'POST', headers: { 'X-Internal-API-Key': INTERNAL_API_SECRET } },
      env
    );

    expect(response.status).toBe(500);
    expect(invokeScheduled).toHaveBeenCalledTimes(1);
  });
});
