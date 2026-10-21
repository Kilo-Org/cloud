import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type { CloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import type { adminWebhookTriggersRouter as AdminWebhookTriggersRouter } from './admin-webhook-triggers-router';
import type { getWebhookRequestLogs } from '@/lib/webhook-request-logs';
import type {
  createWorkerTrigger as createWorkerTriggerType,
  getWorkerTrigger as getWorkerTriggerType,
  updateWorkerTrigger as updateWorkerTriggerType,
  invokeWorkerScheduledTrigger as invokeWorkerScheduledTriggerType,
  listWorkerRequests as listWorkerRequestsType,
  TriggerConfigResponse,
} from '@/lib/webhook-agent/webhook-agent-client';
import type {
  WebhookTriggerCreateInput as WebhookTriggerCreateInputType,
  WebhookTriggerUpdateInput as WebhookTriggerUpdateInputType,
  webhookTriggersRouter as webhookTriggersRouterType,
} from './webhook-triggers-router';
import {
  getSandboxAllocationRequest,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';

const mockEnsureOrganizationAccess = jest.fn<typeof ensureOrganizationAccess>();
const mockGetWebhookRequestLogs = jest.fn<typeof getWebhookRequestLogs>();
jest.mock('@/lib/webhook-request-logs', () => ({
  getWebhookRequestLogs: mockGetWebhookRequestLogs,
}));
const mockGetSandboxSelectionOptions =
  jest.fn<CloudAgentNextClient['getSandboxSelectionOptions']>();

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: () => ({
    getSandboxSelectionOptions: mockGetSandboxSelectionOptions,
  }),
}));

jest.mock('@kilocode/web-shared/lib/tokens', () => ({
  generateCloudAgentToken: () => 'test-cloud-agent-token',
}));

const mockCreateWorkerTrigger = jest.fn<typeof createWorkerTriggerType>();
const mockGetWorkerTrigger = jest.fn<typeof getWorkerTriggerType>();
const mockUpdateWorkerTrigger = jest.fn<typeof updateWorkerTriggerType>();
const mockInvokeWorkerScheduledTrigger = jest.fn<typeof invokeWorkerScheduledTriggerType>();
const mockListWorkerRequests = jest.fn<typeof listWorkerRequestsType>();
const mockDbInsert = jest.fn();
const mockDbUpdate = jest.fn();
const mockDbDelete = jest.fn();
const mockFindAdmin = jest.fn<() => Promise<Partial<User> | undefined>>();
const mockSelectWhere = jest.fn<
  () => Promise<
    Array<{
      id: string;
      activation_mode: string;
      target_type: 'cloud_agent' | 'kiloclaw_chat';
      github_repo?: string | null;
    }>
  >
>();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    query: { kilocode_users: { findFirst: mockFindAdmin } },
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
    delete: mockDbDelete.mockImplementation(() => ({
      where: () => Promise.resolve(),
    })),
  },
}));

jest.mock('@/lib/webhook-agent/webhook-agent-client', () => ({
  buildInboundUrl: jest.fn(() => 'https://inbound'),
  createWorkerTrigger: mockCreateWorkerTrigger,
  getWorkerTrigger: mockGetWorkerTrigger,
  updateWorkerTrigger: mockUpdateWorkerTrigger,
  invokeWorkerScheduledTrigger: mockInvokeWorkerScheduledTrigger,
  listWorkerRequests: mockListWorkerRequests,
}));

jest.mock('@kilocode/web-shared/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockEnsureOrganizationAccess,
}));

let createCaller: ReturnType<
  typeof createCallerFactory<typeof webhookTriggersRouterType._def.record>
>;
let WebhookTriggerCreateInput: typeof WebhookTriggerCreateInputType;
let WebhookTriggerUpdateInput: typeof WebhookTriggerUpdateInputType;
let createAdminCaller: ReturnType<
  typeof createCallerFactory<typeof AdminWebhookTriggersRouter._def.record>
>;

const user = { id: 'user-1', is_admin: false } as User;
const creatorSecret = 'creator-secret-0123456789';
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
  const adminRouter = await import('./admin-webhook-triggers-router');
  createAdminCaller = createCallerFactory(adminRouter.adminWebhookTriggersRouter);
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
    mockGetWorkerTrigger.mockResolvedValue({ found: true, config: triggerConfig });
    mockUpdateWorkerTrigger.mockResolvedValue({ success: true, config: triggerConfig });
    mockInvokeWorkerScheduledTrigger.mockResolvedValue({
      success: true,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockGetSandboxSelectionOptions.mockResolvedValue({ enabled: false, options: [] });
    mockFindAdmin.mockResolvedValue({
      is_admin: true,
      can_view_sessions: true,
      blocked_reason: null,
    });
  });

  it('authorizes personal request logs before reading the worker', async () => {
    mockGetWebhookRequestLogs.mockResolvedValue({
      logs: [],
      transcript: null,
      processStatus: 'captured',
      logsReady: false,
    });
    await createCaller({ user }).getRequestLogs({
      triggerId: 'trigger-id',
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    expect(mockGetWebhookRequestLogs).toHaveBeenCalledWith(
      user.id,
      undefined,
      'trigger-id',
      '00000000-0000-4000-8000-000000000005'
    );
  });

  it('requires admin session viewing permission for request logs', async () => {
    mockFindAdmin.mockResolvedValue({
      is_admin: true,
      can_view_sessions: false,
      blocked_reason: null,
    });
    await expect(
      createAdminCaller({ user: { ...user, is_admin: true } }).getRequestLogs({
        scope: 'user',
        userId: 'target',
        triggerId: 'trigger-id',
        requestId: '00000000-0000-4000-8000-000000000005',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockGetWebhookRequestLogs).not.toHaveBeenCalled();
  });

  it('uses the selected personal admin scope rather than the admin owner', async () => {
    await createAdminCaller({ user: { ...user, is_admin: true } }).getRequestLogs({
      scope: 'user',
      userId: 'target',
      triggerId: 'trigger-id',
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    expect(mockGetWebhookRequestLogs).toHaveBeenCalledWith(
      'target',
      undefined,
      'trigger-id',
      '00000000-0000-4000-8000-000000000005'
    );
  });

  it('uses the selected organization admin scope', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    await createAdminCaller({ user: { ...user, is_admin: true } }).getRequestLogs({
      scope: 'organization',
      organizationId,
      triggerId: 'trigger-id',
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    expect(mockGetWebhookRequestLogs).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      '00000000-0000-4000-8000-000000000005'
    );
  });

  it('rejects an admin trigger outside the selected scope before reading logs', async () => {
    mockSelectWhere.mockResolvedValue([]);
    await expect(
      createAdminCaller({ user: { ...user, is_admin: true } }).getRequestLogs({
        scope: 'user',
        userId: 'target',
        triggerId: 'trigger-id',
        requestId: '00000000-0000-4000-8000-000000000005',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetWebhookRequestLogs).not.toHaveBeenCalled();
  });

  it('denies request logs when the trigger is not owned', async () => {
    mockSelectWhere.mockResolvedValue([]);
    await expect(
      createCaller({ user }).getRequestLogs({
        triggerId: 'trigger-id',
        requestId: '00000000-0000-4000-8000-000000000005',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetWebhookRequestLogs).not.toHaveBeenCalled();
  });

  it('checks organization access before retrieving request logs', async () => {
    mockEnsureOrganizationAccess.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(
      createCaller({ user }).getRequestLogs({
        triggerId: 'trigger-id',
        requestId: '00000000-0000-4000-8000-000000000005',
        organizationId: '00000000-0000-4000-8000-000000000001',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockGetWebhookRequestLogs).not.toHaveBeenCalled();
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

  it('keeps bot execution as the default for organization triggers', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    await createCaller({ user }).create({ ...createInput, organizationId });
    expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      expect.objectContaining({ executionUserId: undefined })
    );
  });

  it('derives creator execution identity from the authenticated user, not input', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    const forgedInput = {
      ...createInput,
      organizationId,
      runAsCreator: true,
      executionUserId: 'another-user',
      webhookAuth: { header: 'x-secret', secret: creatorSecret },
    };
    await createCaller({ user }).create(forgedInput);
    expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      expect.objectContaining({ executionUserId: user.id })
    );
  });

  it('requires organization scope and authentication for creator webhooks', () => {
    const organizationId = '00000000-0000-4000-8000-000000000001';
    expect(
      WebhookTriggerCreateInput.safeParse({ ...createInput, runAsCreator: true }).success
    ).toBe(false);
    expect(
      WebhookTriggerCreateInput.safeParse({ ...createInput, organizationId, runAsCreator: true })
        .success
    ).toBe(false);
    expect(
      WebhookTriggerCreateInput.safeParse({
        ...createInput,
        organizationId,
        runAsCreator: true,
        activationMode: 'scheduled',
        cronExpression: '0 9 * * *',
      }).success
    ).toBe(true);
    expect(
      WebhookTriggerCreateInput.safeParse({
        triggerId: 'trigger-id',
        promptTemplate: 'Run task',
        targetType: 'kiloclaw_chat',
        kiloclawInstanceId: organizationId,
        organizationId,
        runAsCreator: true,
        webhookAuth: { header: 'x-secret', secret: creatorSecret },
      }).success
    ).toBe(false);
  });

  it('requires a strong shared secret for creator webhooks', () => {
    const input = {
      ...createInput,
      organizationId: '00000000-0000-4000-8000-000000000001',
      runAsCreator: true,
    };
    const weak = WebhookTriggerCreateInput.safeParse({
      ...input,
      webhookAuth: { header: 'x-secret', secret: `  ${'a'.repeat(15)}  ` },
    });
    expect(weak.success).toBe(false);
    expect(weak.error?.issues[0]?.path).toEqual(['webhookAuth', 'secret']);
    expect(
      WebhookTriggerCreateInput.safeParse({
        ...input,
        webhookAuth: { header: 'x-secret', secret: 'a'.repeat(16) },
      }).success
    ).toBe(true);
    expect(
      WebhookTriggerCreateInput.safeParse({
        ...createInput,
        webhookAuth: { header: 'x-secret', secret: 'short' },
      }).success
    ).toBe(true);
  });

  it('rejects a weak replacement secret on a creator-run trigger before updating', async () => {
    mockGetWorkerTrigger.mockResolvedValue({
      found: true,
      config: { ...triggerConfig, executionUserId: user.id },
    });
    await expect(
      createCaller({ user }).update({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000001',
        webhookAuth: { secret: 'short' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('cleans up the PostgreSQL record when the worker no longer has an organization trigger', async () => {
    mockGetWorkerTrigger.mockResolvedValue({ found: false });
    await expect(
      createCaller({ user }).update({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000001',
        promptTemplate: 'Changed prompt',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('rejects inherited or admin-only access for creator execution before inserting a trigger', async () => {
    mockSelectWhere.mockResolvedValue([]);
    await expect(
      createCaller({ user }).create({
        ...createInput,
        organizationId: '00000000-0000-4000-8000-000000000001',
        runAsCreator: true,
        webhookAuth: { header: 'x-secret', secret: creatorSecret },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('rejects editing another members creator-run trigger before changing configuration', async () => {
    mockGetWorkerTrigger.mockResolvedValue({
      found: true,
      config: { ...triggerConfig, executionUserId: 'another-user' },
    });
    await expect(
      createCaller({ user }).update({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000001',
        promptTemplate: 'Changed prompt',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('allows the creator to edit without changing execution identity', async () => {
    mockGetWorkerTrigger.mockResolvedValue({
      found: true,
      config: { ...triggerConfig, executionUserId: user.id },
    });
    const organizationId = '00000000-0000-4000-8000-000000000001';
    await createCaller({ user }).update({
      triggerId: 'trigger-id',
      organizationId,
      promptTemplate: 'Changed prompt',
    });
    expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      expect.objectContaining({ promptTemplate: 'Changed prompt' })
    );
    expect(mockUpdateWorkerTrigger.mock.calls[0][3]).not.toHaveProperty('executionUserId');
  });

  it('fails closed when the worker execution identity cannot be read', async () => {
    mockGetWorkerTrigger.mockResolvedValue({ found: 'error', error: 'Unavailable', status: 503 });
    await expect(
      createCaller({ user }).update({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000001',
        isActive: false,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(mockUpdateWorkerTrigger).not.toHaveBeenCalled();
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

  it.each(sandboxAllocationSchema.options)(
    'accepts create sandbox allocation %s',
    sandboxAllocation => {
      expect(
        WebhookTriggerCreateInput.safeParse({ ...createInput, sandboxAllocation }).success
      ).toBe(true);
    }
  );

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

  it.each(sandboxAllocationSchema.options)(
    'accepts update sandbox allocation %s',
    sandboxAllocation => {
      expect(
        WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', sandboxAllocation }).success
      ).toBe(true);
    }
  );

  it('accepts clearing an update sandbox allocation', () => {
    expect(
      WebhookTriggerUpdateInput.safeParse({ triggerId: 'trigger-id', sandboxAllocation: null })
        .success
    ).toBe(true);
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
      const disabledCapabilities = { enabled: false, options: [] };
      const enabledCapabilities = { enabled: true, options: [] };
      mockEnsureOrganizationAccess.mockResolvedValue(role);
      mockGetSandboxSelectionOptions.mockResolvedValueOnce(disabledCapabilities);
      await expect(createCaller({ user }).capabilities({ organizationId })).resolves.toEqual({
        canSetSandboxAllocation: false,
        sandboxSelection: disabledCapabilities,
      });
      mockGetSandboxSelectionOptions.mockResolvedValueOnce(enabledCapabilities);
      await expect(createCaller({ user }).capabilities({ organizationId })).resolves.toEqual({
        canSetSandboxAllocation: true,
        sandboxSelection: enabledCapabilities,
      });
      expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(expect.anything(), organizationId);
      expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({
        kilocodeOrganizationId: organizationId,
      });
    }
  );

  it('passes repository context through to Worker capabilities', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    const capabilities = {
      enabled: true,
      options: [
        {
          allocation: getSandboxAllocationRequest('vercel-small'),
          unavailableReason: 'Vercel sandboxes are not configured',
        },
      ],
    };
    mockGetSandboxSelectionOptions.mockResolvedValueOnce(capabilities);

    await expect(
      createCaller({ user }).capabilities({ organizationId, githubRepo: 'owner/repo' })
    ).resolves.toEqual({
      canSetSandboxAllocation: true,
      sandboxSelection: capabilities,
    });
    expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({
      kilocodeOrganizationId: organizationId,
      repositoryType: 'github',
      repositoryFullName: 'owner/repo',
    });
  });

  it.each([false, true])('never enables personal selection for is_admin=%s', async is_admin => {
    await expect(createCaller({ user: { ...user, is_admin } }).capabilities({})).resolves.toEqual({
      canSetSandboxAllocation: false,
      sandboxSelection: undefined,
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

  it('allows a create allocation that the Worker offers for the repository', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('vercel-small') }],
    });

    await createCaller({ user }).create({
      ...createInput,
      organizationId,
      sandboxAllocation: 'vercel-small',
    });

    expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({
      kilocodeOrganizationId: organizationId,
      repositoryType: 'github',
      repositoryFullName: 'owner/repo',
    });
    expect(mockCreateWorkerTrigger).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      expect.objectContaining({ sandboxAllocation: 'vercel-small' })
    );
  });

  it('uses the stored repository for update allocation capabilities', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockSelectWhere.mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000002',
        activation_mode: 'webhook',
        target_type: 'cloud_agent',
        github_repo: 'owner/stored-repo',
      },
    ]);
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('cloudflare-shared') }],
    });

    await createCaller({ user }).update({
      triggerId: 'trigger-id',
      organizationId,
      sandboxAllocation: 'cloudflare-shared',
    });

    expect(mockGetSandboxSelectionOptions).toHaveBeenCalledWith({
      kilocodeOrganizationId: organizationId,
      repositoryType: 'github',
      repositoryFullName: 'owner/stored-repo',
    });
    expect(mockUpdateWorkerTrigger).toHaveBeenCalledWith(
      undefined,
      organizationId,
      'trigger-id',
      expect.objectContaining({ sandboxAllocation: 'cloudflare-shared' })
    );
  });

  it.each([
    { unavailableReason: 'Vercel sandboxes are not configured' },
    { repositoryUnavailableReason: 'This allocation does not support the repository' },
  ])('rejects an unavailable allocation option %j before writes', async reasons => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('vercel-small'), ...reasons }],
    });

    await expect(
      createCaller({ user }).create({
        ...createInput,
        organizationId,
        sandboxAllocation: 'vercel-small',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: Object.values(reasons)[0],
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('rejects an allocation the Worker does not offer before writes', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockGetSandboxSelectionOptions.mockResolvedValueOnce({ enabled: true, options: [] });

    await expect(
      createCaller({ user }).create({
        ...createInput,
        organizationId,
        sandboxAllocation: 'cloudflare-shared',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('rejects an explicit allocation when the organization does not exist', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockSelectWhere.mockResolvedValueOnce([]);

    await expect(
      createCaller({ user }).create({
        ...createInput,
        organizationId,
        sandboxAllocation: 'cloudflare-shared',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
  });

  it('rejects a personal explicit allocation before requesting capabilities', async () => {
    await expect(
      createCaller({ user }).create({
        ...createInput,
        sandboxAllocation: 'cloudflare-shared',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
    expect(mockCreateWorkerTrigger).not.toHaveBeenCalled();
  });

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
      expect(mockGetSandboxSelectionOptions).not.toHaveBeenCalled();
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
    mockGetWorkerTrigger.mockResolvedValue({ found: true, config: triggerConfig });
    mockInvokeWorkerScheduledTrigger.mockResolvedValue({
      success: true,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
  });

  it('allows only the creator to run a creator-run organization trigger', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000003';
    mockGetWorkerTrigger.mockResolvedValue({
      found: true,
      config: { ...triggerConfig, executionUserId: 'another-user' },
    });
    await expect(
      createCaller({ user }).invoke({ triggerId: 'trigger-id', organizationId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockInvokeWorkerScheduledTrigger).not.toHaveBeenCalled();

    mockGetWorkerTrigger.mockResolvedValue({
      found: true,
      config: { ...triggerConfig, executionUserId: user.id },
    });
    await expect(
      createCaller({ user }).invoke({ triggerId: 'trigger-id', organizationId })
    ).resolves.toEqual({ requestId: '00000000-0000-4000-8000-000000000005' });
  });

  it('fails closed when the organization trigger execution identity cannot be read', async () => {
    mockGetWorkerTrigger.mockResolvedValue({ found: 'error', error: 'Unavailable', status: 503 });
    await expect(
      createCaller({ user }).invoke({
        triggerId: 'trigger-id',
        organizationId: '00000000-0000-4000-8000-000000000003',
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(mockInvokeWorkerScheduledTrigger).not.toHaveBeenCalled();
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

describe('webhook trigger request listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectWhere.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        activation_mode: 'webhook',
        target_type: 'cloud_agent',
      },
    ]);
    mockEnsureOrganizationAccess.mockResolvedValue('owner');
    mockListWorkerRequests.mockResolvedValue({ success: true, requests: [] });
  });

  it('returns captured requests for a paused trigger without changing the trigger record', async () => {
    await expect(createCaller({ user }).listRequests({ triggerId: 'trigger-id' })).resolves.toEqual(
      []
    );

    expect(mockListWorkerRequests).toHaveBeenCalledWith('user-1', undefined, 'trigger-id', 50);
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('does not delete the PostgreSQL record when the worker reports a missing trigger', async () => {
    mockListWorkerRequests.mockResolvedValueOnce({
      success: false,
      error: 'Trigger not found',
      status: 404,
      isNotFound: true,
    });

    await expect(
      createCaller({ user }).listRequests({ triggerId: 'trigger-id' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockDbDelete).not.toHaveBeenCalled();
  });
});
