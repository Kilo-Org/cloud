import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type {
  createWorkerTrigger as createWorkerTriggerType,
  updateWorkerTrigger as updateWorkerTriggerType,
  invokeWorkerScheduledTrigger as invokeWorkerScheduledTriggerType,
  TriggerConfigResponse,
} from '@/lib/webhook-agent/webhook-agent-client';
import type {
  WebhookTriggerCreateInput as WebhookTriggerCreateInputType,
  WebhookTriggerUpdateInput as WebhookTriggerUpdateInputType,
  webhookTriggersRouter as webhookTriggersRouterType,
} from './webhook-triggers-router';

const mockEnsureOrganizationAccess = jest.fn<typeof ensureOrganizationAccess>();
const mockGetSandboxSelectionOptions =
  jest.fn<CloudAgentNextClient['getSandboxSelectionOptions']>();

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: () => ({
    getSandboxSelectionOptions: mockGetSandboxSelectionOptions,
  }),
}));

jest.mock('@/lib/tokens', () => ({
  generateCloudAgentToken: () => 'test-cloud-agent-token',
}));

const mockCreateWorkerTrigger = jest.fn<typeof createWorkerTriggerType>();
const mockUpdateWorkerTrigger = jest.fn<typeof updateWorkerTriggerType>();
const mockInvokeWorkerScheduledTrigger = jest.fn<typeof invokeWorkerScheduledTriggerType>();
const mockDbInsert = jest.fn();
const mockDbUpdate = jest.fn();
const mockSelectWhere = jest.fn<
  () => Promise<
    Array<{
      id: string;
      activation_mode: string;
      target_type: 'cloud_agent' | 'kiloclaw_chat';
    }>
  >
>();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mockSelectWhere,
      }),
    }),
    insert: mockDbInsert.mockImplementation(() => ({
      values: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: '00000000-0000-4000-8000-000000000002',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ]),
      }),
    })),
    update: mockDbUpdate.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve() }),
    })),
  },
}));

jest.mock('@/lib/webhook-agent/webhook-agent-client', () => ({
  buildInboundUrl: jest.fn(() => 'https://inbound'),
  createWorkerTrigger: mockCreateWorkerTrigger,
  updateWorkerTrigger: mockUpdateWorkerTrigger,
  invokeWorkerScheduledTrigger: mockInvokeWorkerScheduledTrigger,
}));

jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockEnsureOrganizationAccess,
}));

let createCaller: ReturnType<
  typeof createCallerFactory<typeof webhookTriggersRouterType._def.record>
>;
let WebhookTriggerCreateInput: typeof WebhookTriggerCreateInputType;
let WebhookTriggerUpdateInput: typeof WebhookTriggerUpdateInputType;

const user = { id: 'user-1', is_admin: false } as User;
const createInput = {
  triggerId: 'trigger-id',
  githubRepo: 'owner/repo',
  mode: 'code' as const,
  model: 'model',
  profileId: '00000000-0000-4000-8000-000000000001',
  promptTemplate: 'Run task',
};
const triggerConfig: TriggerConfigResponse = {
  triggerId: 'trigger-id',
  namespace: 'user/user-1',
  userId: 'user-1',
  orgId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  isActive: true,
  targetType: 'cloud_agent',
  githubRepo: 'owner/repo',
  mode: 'code',
  model: 'model',
  promptTemplate: 'Run task',
  webhookAuthConfigured: false,
  activationMode: 'webhook',
};

beforeAll(async () => {
  const router = await import('./webhook-triggers-router');
  createCaller = createCallerFactory(router.webhookTriggersRouter);
  WebhookTriggerCreateInput = router.WebhookTriggerCreateInput;
  WebhookTriggerUpdateInput = router.WebhookTriggerUpdateInput;
});

describe('webhook trigger variant inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectWhere.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        activation_mode: 'webhook',
        target_type: 'cloud_agent',
      },
    ]);
    mockCreateWorkerTrigger.mockResolvedValue({ success: true, inboundUrl: 'https://inbound' });
    mockUpdateWorkerTrigger.mockResolvedValue({ success: true, config: triggerConfig });
    mockInvokeWorkerScheduledTrigger.mockResolvedValue({
      success: true,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockGetSandboxSelectionOptions.mockResolvedValue({ enabled: false, options: [] });
  });

  it.each(['high', 'High', 'a'.repeat(50)])('accepts valid create variant %s', variant => {
    expect(WebhookTriggerCreateInput.safeParse({ ...createInput, variant }).success).toBe(true);
  });

  it.each(['', 'high-effort', 'high1', 'a'.repeat(51)])(
    'rejects invalid create variant %s',
    variant => {
      expect(WebhookTriggerCreateInput.safeParse({ ...createInput, variant }).success).toBe(false);
    }
  );

  it('accepts set and clear updates while preserving omission', () => {
    expect(WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id' })).toMatchObject({
      success: true,
      data: { triggerId: 'trigger-id' },
    });
    expect(
      WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', variant: 'high' })
    ).toMatchObject({ success: true, data: { triggerId: 'trigger-id', variant: 'high' } });
    expect(
      WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', variant: null })
    ).toMatchObject({ success: true, data: { triggerId: 'trigger-id', variant: null } });
  });

  it.each(['', 'high-effort', 'high1', 'a'.repeat(51)])(
    'rejects invalid update variant %s',
    variant => {
      expect(
        WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', variant }).success
      ).toBe(false);
    }
  );

  it('forwards an omitted create variant', async () => {
    await createCaller({ user }).create(createInput);

    expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id',
      expect.objectContaining({ variant: undefined })
    );
  });

  it('forwards a configured create variant', async () => {
    await createCaller({ user }).create({ ...createInput, variant: 'high' });

    expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id',
      expect.objectContaining({ variant: 'high' })
    );
  });

  it('forwards an omitted update variant', async () => {
    await createCaller({ user }).update({ triggerId: 'trigger-id', isActive: false });

    expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id',
      expect.objectContaining({ variant: undefined })
    );
  });

  it('forwards a variant-only update', async () => {
    await createCaller({ user }).update({ triggerId: 'trigger-id', variant: 'high' });

    expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id',
      expect.objectContaining({ variant: 'high' })
    );
  });

  it('forwards an explicit null update variant', async () => {
    await createCaller({ user }).update({ triggerId: 'trigger-id', variant: null });

    expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id',
      expect.objectContaining({ variant: null })
    );
  });

  it.each(['standard', '', null])(
    'rejects invalid create sandbox allocation %s',
    sandboxAllocation => {
      expect(
        WebhookTriggerCreateInput.safeParse({ ...createInput, sandboxAllocation }).success
      ).toBe(false);
    }
  );

  it('rejects sandbox allocation for KiloClaw creates', () => {
    expect(
      WebhookTriggerCreateInput.safeParse({
        triggerId: 'trigger-id',
        targetType: 'kiloclaw_chat',
        kiloclawInstanceId: '00000000-0000-4000-8000-000000000004',
        promptTemplate: 'Run task',
        sandboxAllocation: 'isolated-standard',
      }).success
    ).toBe(false);
  });

  it.each(['standard', 'isolated', ''])(
    'rejects invalid update sandbox allocation %s',
    sandboxAllocation => {
      expect(
        WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', sandboxAllocation }).success
      ).toBe(false);
    }
  );

  it.each(['owner', 'admin', 'member'] as const)(
    'uses Worker organization capabilities for an organization %s',
    async role => {
      const organizationId = '00000000-0000-4000-8000-000000000003';
      mockEnsureOrganizationAccess.mockResolvedValue(role);
      await expect(createCaller({ user }).capabilities({ organizationId })).resolves.toEqual({
        canSetSandboxAllocation: false,
      });
      mockGetSandboxSelectionOptions.mockResolvedValueOnce({ enabled: true, options: [] });
      await expect(createCaller({ user }).capabilities({ organizationId })).resolves.toEqual({
        canSetSandboxAllocation: true,
      });
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(expect.anything(), organizationId);
      expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({
        kilocodeOrganizationId: organizationId,
      });
    }
  );

  it.each([false, true])('never enables personal selection for is_admin=%s', async is_admin => {
    await expect(createCaller({ user: { ...user, is_admin } }).capabilities({})).resolves.toEqual({
      canSetSandboxAllocation: false,
    });
    expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
  });

  it('checks organization access before requesting Worker capabilities', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockEnsureOrganizationAccess.mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED' }));
    await expect(createCaller({ user }).capabilities({ organizationId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
  });

  it.each(['webhook', 'scheduled'] as const)(
    'allows an enrolled organization member to set Dedicated Standard on %s triggers',
    async activationMode => {
      const organizationId = '00000000-0000-4000-8000-000000000003';
      mockEnsureOrganizationAccess.mockResolvedValue('member');
      mockGetSandboxSelectionOptions.mockResolvedValue({ enabled: true, options: [] });
      await createCaller({ user }).create({
        ...createInput,
        organizationId,
        activationMode,
        ...(activationMode === 'scheduled' ? { cronExpression: '* * * * *' } : {}),
        sandboxAllocation: 'isolated-standard',
      });
      expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
        undefined,
        organizationId,
        'trigger-id',
        expect.objectContaining({ sandboxAllocation: 'isolated-standard' })
      );

      mockSelectWhere.mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000002',
          activation_mode: activationMode,
          target_type: 'cloud_agent',
        },
      ]);
      await createCaller({ user }).update({
        triggerId: 'trigger-id',
        organizationId,
        sandboxAllocation: 'isolated-standard',
      });
      expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
        undefined,
        organizationId,
        'trigger-id',
        expect.objectContaining({ sandboxAllocation: 'isolated-standard' })
      );
    }
  );

  it.each([
    { activationMode: 'webhook', organizationId: undefined },
    { activationMode: 'scheduled', organizationId: '00000000-0000-4000-8000-000000000003' },
  ] as const)(
    'allows a non-admin to clear and preserve omission for $activationMode triggers',
    async ({ activationMode, organizationId }) => {
      mockSelectWhere.mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000002',
          activation_mode: activationMode,
          target_type: 'cloud_agent',
        },
      ]);
      await createCaller({ user }).update({
        triggerId: 'trigger-id',
        ...(organizationId ? { organizationId } : {}),
        sandboxAllocation: null,
      });
      expect(mockUpdateWorkerTrigger).toHaveBeenLastCalledWith(
        organizationId ? undefined : 'user-1',
        organizationId,
        'trigger-id',
        expect.objectContaining({ sandboxAllocation: null })
      );

      await createCaller({ user }).update({
        triggerId: 'trigger-id',
        ...(organizationId ? { organizationId } : {}),
        isActive: false,
      });
      expect(mockUpdateWorkerTrigger).toHaveBeenLastCalledWith(
        organizationId ? undefined : 'user-1',
        organizationId,
        'trigger-id',
        expect.objectContaining({ sandboxAllocation: undefined })
      );
    }
  );

  it.each([
    { activationMode: 'webhook', is_admin: false },
    { activationMode: 'webhook', is_admin: true },
    { activationMode: 'scheduled', is_admin: false },
    { activationMode: 'scheduled', is_admin: true },
  ] as const)(
    'rejects unenrolled Dedicated Standard $activationMode triggers for is_admin=$is_admin before writes',
    async ({ activationMode, is_admin }) => {
      const caller = createCaller({ user: { ...user, is_admin } });
      for (const organizationId of [undefined, '00000000-0000-4000-8000-000000000003']) {
        await expect(
          caller.create({
            ...createInput,
            organizationId,
            activationMode,
            ...(activationMode === 'scheduled' ? { cronExpression: '* * * * *' } : {}),
            sandboxAllocation: 'isolated-standard',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          caller.update({
            triggerId: 'trigger-id',
            organizationId,
            sandboxAllocation: 'isolated-standard',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(mockDbInsert).not.toHaveBeenCalled();
      expect(mockDbUpdate).not.toHaveBeenCalled();
      expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
      expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
    }
  );

  it('fails closed before writes when Worker capabilities are unavailable', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockGetSandboxSelectionOptions.mockRejectedValue(new Error('Capabilities unavailable'));
    const caller = createCaller({ user });
    await expect(
      caller.create({ ...createInput, organizationId, sandboxAllocation: 'isolated-standard' })
    ).rejects.toThrow('Capabilities unavailable');
    await expect(
      caller.update({
        triggerId: 'trigger-id',
        organizationId,
        sandboxAllocation: 'isolated-standard',
      })
    ).rejects.toThrow('Capabilities unavailable');
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
  });

  it.each([null, 'isolated-standard'] as const)(
    'rejects stored KiloClaw allocation update %s even with a forged cloud-agent target',
    async sandboxAllocation => {
      mockSelectWhere.mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000002',
          activation_mode: 'webhook',
          target_type: 'kiloclaw_chat',
        },
      ]);
      const forgedInput = { triggerId: 'trigger-id', sandboxAllocation, targetType: 'cloud_agent' };
      await expect(
        createCaller({ user: { ...user, is_admin: true } }).update(forgedInput)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
    }
  );

  it('returns not found for an unknown trigger before contacting the worker', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    await expect(
      createCaller({ user }).update({
        triggerId: 'trigger-id',
        sandboxAllocation: 'isolated-standard',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
  });
});

describe('scheduled trigger invocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectWhere.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        activation_mode: 'scheduled',
        target_type: 'cloud_agent',
      },
    ]);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockInvokeWorkerScheduledTrigger.mockResolvedValue({
      success: true,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
  });

  it('invokes an owned personal trigger using the authenticated user namespace', async () => {
    await expect(createCaller({ user }).invoke({ triggerId: 'trigger-id' })).resolves.toEqual({
      requestId: '00000000-0000-4000-8000-000000000005',
    });

    expect(mockInvokeWorkerScheduledTrigger).toHaveBeenCalledWith(
      'user-1',
      undefined,
      'trigger-id'
    );
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('allows organization owners and members to invoke owned organization triggers', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    for (const role of ['owner', 'member'] as const) {
      mockEnsureOrganizationAccess.mockResolvedValueOnce(role);
      await createCaller({ user }).invoke({ triggerId: 'trigger-id', organizationId });
    }

    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(expect.anything(), organizationId, [
      'owner',
      'member',
    ]);
    expect(mockInvokeWorkerScheduledTrigger).toHaveBeenLastCalledWith(
      undefined,
      organizationId,
      'trigger-id'
    );
  });

  it('rejects missing and cross-scope triggers before contacting the worker', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);
    await expect(createCaller({ user }).invoke({ triggerId: 'trigger-id' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    mockSelectWhere.mockResolvedValueOnce([]);
    await expect(
      createCaller({ user }).invoke({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000003',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockInvokeWorkerScheduledTrigger).not.toHaveBeenCalled();
  });

  it('rejects unauthorized organizations before checking ownership or contacting the worker', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockEnsureOrganizationAccess.mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED' }));

    await expect(
      createCaller({ user }).invoke({ triggerId: 'trigger-id', organizationId })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockInvokeWorkerScheduledTrigger).not.toHaveBeenCalled();
  });

  it('rejects forged fields without contacting the worker', async () => {
    await expect(
      createCaller({ user }).invoke({
        triggerId: 'trigger-id',
        targetType: 'cloud_agent',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockInvokeWorkerScheduledTrigger).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'NOT_FOUND'],
    [400, 'BAD_REQUEST'],
    [409, 'CONFLICT'],
    [429, 'TOO_MANY_REQUESTS'],
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'INTERNAL_SERVER_ERROR'],
  ])('maps worker status %s to %s', async (status, code) => {
    mockInvokeWorkerScheduledTrigger.mockResolvedValueOnce({
      success: false,
      error: 'untrusted worker detail',
      status,
    });

    await expect(createCaller({ user }).invoke({ triggerId: 'trigger-id' })).rejects.toMatchObject({
      code,
    });
  });
});
