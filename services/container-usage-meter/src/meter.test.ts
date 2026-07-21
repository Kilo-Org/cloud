import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startIdempotencyKey, type RecordStartInput } from '@kilocode/container-usage';
import type {
  DurableStartAdmissionResult,
  ExistingStartAdmissionResult,
  StartAdmission,
} from './failover-contract';

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

vi.mock('./postgres', () => ({ validateStartSku: vi.fn() }));

import { validateStartSku } from './postgres';
import { ContainerUsageMeter } from './meter';

const admitStart = vi.fn(
  async (_mutation: unknown, admission: StartAdmission): Promise<DurableStartAdmissionResult> =>
    admission.accepted
      ? { status: 'accepted', dedup: false }
      : { status: 'rejected', code: admission.code, message: admission.message }
);
const getStartAdmission = vi.fn(
  async (): Promise<ExistingStartAdmissionResult> => ({ status: 'absent' })
);

function createMeter() {
  const env = {
    FAILOVER_BUFFER: {
      getByName: vi.fn(() => ({ admitStart, getStartAdmission })),
    },
  } as unknown as Cloudflare.Env;
  return new ContainerUsageMeter({} as ExecutionContext, env);
}

function validStart(): RecordStartInput {
  return {
    service: 'cloud-agent-next',
    instanceId: 'instance-1',
    startEpochMs: 123,
    sku: 'cloud-agent-standard',
    subject: { type: 'user', id: 'user-1' },
    actor: { type: 'user', id: 'user-1' },
    idempotencyKey: startIdempotencyKey('cloud-agent-next', 'instance-1', 123),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateStartSku).mockResolvedValue({ accepted: true });
  getStartAdmission.mockResolvedValue({ status: 'absent' });
  admitStart.mockImplementation(
    async (_mutation, admission): Promise<DurableStartAdmissionResult> =>
      admission.accepted
        ? { status: 'accepted', dedup: false }
        : { status: 'rejected', code: admission.code, message: admission.message }
  );
});

describe('ContainerUsageMeter.recordStart', () => {
  it('admits an active per-second SKU and buffers the start', async () => {
    const result = await createMeter().recordStart(validStart());

    expect(validateStartSku).toHaveBeenCalledWith(expect.anything(), 'cloud-agent-standard');
    expect(admitStart).toHaveBeenCalledOnce();
    expect(result).toEqual({
      success: true,
      ack: { intervalId: 'instance-1:123', durable: 'buffer', dedup: false },
    });
  });

  it.each([
    ['sku_not_found' as const, 'Billing SKU not found'],
    ['sku_unit_mismatch' as const, 'Billing SKU is not measured in seconds'],
    ['sku_not_accepting_new_usage' as const, 'Billing SKU is not accepting new usage'],
  ])('returns structured permanent admission failure %s', async (code, message) => {
    vi.mocked(validateStartSku).mockResolvedValue({ accepted: false, code, message });

    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: false,
      error: { code, message },
    });
    expect(admitStart).toHaveBeenCalledOnce();
  });

  it('returns the existing accepted decision after SKU disablement', async () => {
    vi.mocked(validateStartSku).mockResolvedValue({
      accepted: false,
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    getStartAdmission.mockResolvedValue({ status: 'accepted', dedup: true });

    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: true,
      ack: { intervalId: 'instance-1:123', durable: 'buffer', dedup: true },
    });
    expect(validateStartSku).not.toHaveBeenCalled();
  });

  it('propagates catalog infrastructure failures without buffering', async () => {
    vi.mocked(validateStartSku).mockRejectedValue(new Error('postgres unavailable'));

    await expect(createMeter().recordStart(validStart())).rejects.toThrow('postgres unavailable');
    expect(admitStart).not.toHaveBeenCalled();
  });

  it('returns a durable rejected decision without requiring Postgres', async () => {
    getStartAdmission.mockResolvedValue({
      status: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    vi.mocked(validateStartSku).mockRejectedValue(new Error('postgres unavailable'));

    await expect(createMeter().recordStart(validStart())).resolves.toEqual({
      success: false,
      error: {
        code: 'sku_not_accepting_new_usage',
        message: 'Billing SKU is not accepting new usage',
      },
    });
    expect(validateStartSku).not.toHaveBeenCalled();
  });
});
