import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type {
  createWorkerTrigger as createWorkerTriggerType,
  updateWorkerTrigger as updateWorkerTriggerType,
  TriggerConfigResponse,
} from '@/lib/webhook-agent/webhook-agent-client';
import type {
  WebhookTriggerCreateInput as WebhookTriggerCreateInputType,
  WebhookTriggerUpdateInput as WebhookTriggerUpdateInputType,
  webhookTriggersRouter as webhookTriggersRouterType,
} from './webhook-triggers-router';

const mockEnsureOrganizationAccess = jest.fn<typeof ensureOrganizationAccess>();

const mockCreateWorkerTrigger = jest.fn<typeof createWorkerTriggerType>();
const mockUpdateWorkerTrigger = jest.fn<typeof updateWorkerTriggerType>();
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
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
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
    'reports actual platform-admin capability for an organization %s',
    async role => {
      const organizationId = '00000000-0000-4000-8000-000000000003';
      mockEnsureOrganizationAccess.mockResolvedValueOnce(role);
      await expect(createCaller({ user }).capabilities({ organizationId })).resolves.toEqual({
        canSetSandboxAllocation: false,
      });
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(expect.anything(), organizationId);
    }
  );

  it('reports platform-admin capability and preserves organization access checks', async () => {
    await expect(createCaller({ user }).capabilities({})).resolves.toEqual({
      canSetSandboxAllocation: false,
    });
    await expect(
      createCaller({ user: { ...user, is_admin: true } }).capabilities({})
    ).resolves.toEqual({ canSetSandboxAllocation: true });

    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockEnsureOrganizationAccess.mockRejectedValueOnce(new TRPCError({ code: 'UNAUTHORIZED' }));
    await expect(createCaller({ user }).capabilities({ organizationId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it.each([
    { scope: 'personal', activationMode: 'webhook', organizationId: undefined },
    {
      scope: 'organization',
      activationMode: 'webhook',
      organizationId: '00000000-0000-4000-8000-000000000003',
    },
    { scope: 'personal', activationMode: 'scheduled', organizationId: undefined },
    {
      scope: 'organization',
      activationMode: 'scheduled',
      organizationId: '00000000-0000-4000-8000-000000000003',
    },
  ] as const)(
    'allows a Kilo admin to create and update Dedicated Standard for $scope $activationMode triggers',
    async ({ activationMode, organizationId }) => {
      const admin = { ...user, is_admin: true };
      const triggerInput = {
        ...createInput,
        ...(organizationId ? { organizationId } : {}),
        activationMode,
        ...(activationMode === 'scheduled' ? { cronExpression: '* * * * *' } : {}),
        sandboxAllocation: 'isolated-standard' as const,
      };
      await createCaller({ user: admin }).create(triggerInput);
      expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
        organizationId ? undefined : 'user-1',
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
      await createCaller({ user: admin }).update({
        triggerId: 'trigger-id',
        ...(organizationId ? { organizationId } : {}),
        sandboxAllocation: 'isolated-standard',
      });
      expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
        organizationId ? undefined : 'user-1',
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

  it.each(['webhook', 'scheduled'] as const)(
    'rejects a non-admin Dedicated Standard create and update for %s triggers before writes',
    async activationMode => {
      const input = {
        ...createInput,
        activationMode,
        ...(activationMode === 'scheduled' ? { cronExpression: '* * * * *' } : {}),
        sandboxAllocation: 'isolated-standard' as const,
      };
      await expect(createCaller({ user }).create(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Kilo admin access is required to select Dedicated Standard',
      });
      await expect(
        createCaller({ user }).update({
          triggerId: 'trigger-id',
          sandboxAllocation: 'isolated-standard',
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Kilo admin access is required to select Dedicated Standard',
      });
      expect(mockDbInsert).not.toHaveBeenCalled();
      expect(mockDbUpdate).not.toHaveBeenCalled();
      expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
      expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
    }
  );

  it('does not grant allocation privileges to an organization owner or member', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    for (const role of ['owner', 'member'] as const) {
      mockEnsureOrganizationAccess.mockResolvedValueOnce(role);
      await expect(
        createCaller({ user }).create({
          ...createInput,
          organizationId,
          sandboxAllocation: 'isolated-standard',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
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
