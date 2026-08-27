import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
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

const mockCreateWorkerTrigger = jest.fn<typeof createWorkerTriggerType>();
const mockUpdateWorkerTrigger = jest.fn<typeof updateWorkerTriggerType>();
const mockSelectWhere = jest.fn<
  () => Promise<
    Array<{
      id: string;
      activation_mode: string;
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
    insert: () => ({
      values: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: '00000000-0000-4000-8000-000000000002',
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ]),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

jest.mock('@/lib/webhook-agent/webhook-agent-client', () => ({
  buildInboundUrl: jest.fn(() => 'https://inbound'),
  createWorkerTrigger: mockCreateWorkerTrigger,
  updateWorkerTrigger: mockUpdateWorkerTrigger,
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
      },
    ]);
    mockCreateWorkerTrigger.mockResolvedValue({ success: true, inboundUrl: 'https://inbound' });
    mockUpdateWorkerTrigger.mockResolvedValue({ success: true, config: triggerConfig });
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
});
