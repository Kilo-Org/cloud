import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  heartbeatIdempotencyKey,
  startIdempotencyKey,
  stopIdempotencyKey,
  type RecordHeartbeatInput,
  type RecordStartInput,
  type RecordStopInput,
} from '@kilocode/container-usage';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    env: Cloudflare.Env;
    ctx: ExecutionContext;

    constructor(ctx: ExecutionContext, env: Cloudflare.Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('./postgres', () => ({
  applyStart: vi.fn(),
  applyHeartbeat: vi.fn(),
  applyStop: vi.fn(),
  getContainerUsageDb: vi.fn(),
  resolveBillingMode: vi.fn(),
}));

import { applyHeartbeat, applyStart, applyStop, resolveBillingMode } from './postgres';
import { ContainerUsageMeter } from './meter';
import { billingModeFor } from './billing-config';

const context = {
  service: 'cloud-agent-next',
  instanceId: 'instance-1',
  sku: 'cloud-agent-standard',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
};

function createMeter(env = {} as Cloudflare.Env) {
  return new ContainerUsageMeter({} as ExecutionContext, env);
}

function validStart(): RecordStartInput {
  return {
    ...context,
    startEpochMs: 123,
    idempotencyKey: startIdempotencyKey(context.service, context.instanceId, 123),
  };
}

function validHeartbeat(): RecordHeartbeatInput {
  return {
    service: context.service,
    instanceId: context.instanceId,
    startEpochMs: 123,
    idempotencyKey: heartbeatIdempotencyKey(context.service, context.instanceId, 123, 1),
    seq: 1,
    usageSinceLast: 300,
    context,
  };
}

function validStop(): RecordStopInput {
  return {
    service: context.service,
    instanceId: context.instanceId,
    startEpochMs: 123,
    idempotencyKey: stopIdempotencyKey(context.service, context.instanceId, 123),
    seq: 2,
    usageSinceLast: 15,
    reason: 'exit',
    exitCode: 0,
    context,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applyStart).mockResolvedValue({ kind: 'applied', dedup: false, billingMode: 'shadow' });
  vi.mocked(applyHeartbeat).mockResolvedValue({
    kind: 'applied',
    dedup: false,
    billingMode: 'shadow',
    budget: { verdict: 'continue' },
  });
  vi.mocked(applyStop).mockResolvedValue({
    kind: 'applied',
    dedup: false,
    billingMode: 'shadow',
    budget: { verdict: 'continue' },
  });
});

describe('ContainerUsageMeter', () => {
  it.each(['paid', 'shadow'] as const)('reports the admission billing decision: %s', async mode => {
    vi.mocked(resolveBillingMode).mockResolvedValueOnce(mode);
    await expect(
      createMeter().getBillingMode({
        service: 'cloud-agent-next-sandbox-containers-code-review',
        subject: { type: 'user', id: 'oauth/provider/user' },
      })
    ).resolves.toBe(mode);
    expect(resolveBillingMode).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ enabled: false }),
      'cloud-agent-next-sandbox-containers-code-review',
      { type: 'user', id: 'oauth/provider/user' },
      expect.any(Date)
    );
    expect(applyStart).not.toHaveBeenCalled();
  });

  it.each([
    { subject: { type: 'user', id: 'paid-user' }, expected: 'paid' },
    { subject: { type: 'org', id: 'paid-org' }, expected: 'paid' },
    { subject: { type: 'user', id: 'paid-org' }, expected: 'shadow' },
    { subject: { type: 'org', id: 'paid-user' }, expected: 'shadow' },
    { subject: { type: 'user', id: 'other-user' }, expected: 'shadow' },
  ] as const)('reads the current billing policy for $subject', async ({ subject, expected }) => {
    const meter = createMeter({
      CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
      CONTAINER_BILLING_USER_IDS: '',
      CONTAINER_BILLING_ORG_IDS: '',
      CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: 'paid-user',
      CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: 'paid-org',
      CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
    } as unknown as Cloudflare.Env);
    vi.mocked(resolveBillingMode).mockImplementationOnce(async (_db, config, service, subject) =>
      billingModeFor(config, service, subject)
    );

    await expect(
      meter.getBillingMode({ service: 'cloud-agent-next-sandbox-containers-standard3', subject })
    ).resolves.toBe(expected);
    expect(applyStart).not.toHaveBeenCalled();
    expect(applyHeartbeat).not.toHaveBeenCalled();
    expect(applyStop).not.toHaveBeenCalled();
  });

  it('writes an admitted start directly to PostgreSQL', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: true,
      ack: { intervalId: 'cloud-agent-next:instance-1:123', durable: 'pg', dedup: false },
    });
    expect(applyStart).toHaveBeenCalledWith(
      expect.anything(),
      validStart(),
      'cloud-agent-next:instance-1:123',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Number),
      expect.objectContaining({ enabled: false })
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Container usage meter RPC completed',
        event: 'container_usage_rpc',
        operation: 'start',
        service: 'cloud-agent-next',
        outcome: 'accepted',
        dedup: false,
      })
    );
  });

  it('returns permanent SKU admission failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(applyStart).mockResolvedValue({
      kind: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: false,
      error: {
        code: 'sku_not_accepting_new_usage',
        message: 'Billing SKU is not accepting new usage',
      },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"rejectionCode":"sku_not_accepting_new_usage"')
    );
  });

  it('returns detailed insufficient-credit rejections from recordStart', async () => {
    vi.mocked(applyStart).mockResolvedValue({
      kind: 'rejected',
      code: 'insufficient_credits',
      message: 'Container billing requires at least $5.00 in remaining credits',
      remainingMicrodollars: 5_000_000,
      minimumRequiredMicrodollars: 5_000_000,
    });

    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: false,
      error: {
        code: 'insufficient_credits',
        message: 'Container billing requires at least $5.00 in remaining credits',
        remainingMicrodollars: 5_000_000,
        minimumRequiredMicrodollars: 5_000_000,
      },
    });
  });

  it('writes heartbeats directly and returns the shadow budget verdict', async () => {
    await expect(createMeter().recordHeartbeat(validHeartbeat())).resolves.toEqual({
      intervalId: 'cloud-agent-next:instance-1:123',
      durable: 'pg',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    expect(applyHeartbeat).toHaveBeenCalledOnce();
  });

  it('writes stops directly to PostgreSQL', async () => {
    await expect(createMeter().recordStop(validStop())).resolves.toEqual({
      intervalId: 'cloud-agent-next:instance-1:123',
      durable: 'pg',
      dedup: false,
    });
    expect(applyStop).toHaveBeenCalledOnce();
  });

  it('propagates transient PostgreSQL failures for bounded client retry', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(applyHeartbeat).mockRejectedValue(new Error('postgres unavailable'));
    await expect(createMeter().recordHeartbeat(validHeartbeat())).rejects.toThrow(
      'postgres unavailable'
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Container usage meter RPC completed',
        event: 'container_usage_rpc',
        operation: 'heartbeat',
        service: 'cloud-agent-next',
        outcome: 'failed',
        errorName: 'Error',
      })
    );
  });
});
