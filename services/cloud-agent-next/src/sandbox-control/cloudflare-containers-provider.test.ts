import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import {
  parseSandboxBillingInput,
  type SandboxBillingAdmissionResult,
} from '../container-usage-context.js';
import type {
  ContainerInstanceSize,
  ContainersObservation,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import { createCloudflareContainersProviderAdapter } from './cloudflare-containers-provider.js';
import { decodeCloudflareProviderRef, encodeCloudflareProviderRef } from './cloudflare-provider.js';
import { CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { DEADLINE_MS } from './deadlines.js';
import { getWorktreeCredentialContainment } from '../sandbox-state/model/allocation.js';
import type { ObserveResult, ProviderCreateIntent } from './provider.js';

const LOGICAL_ID = 'ses-00000000000000000000000001';
const ALLOCATION_A = 'ses-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ALLOCATION_B = 'ses-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const INTENT_ID = 'intent-1';
const NOW = 1_000_000;

const REF_A = encodeCloudflareProviderRef({
  sandboxId: ALLOCATION_A,
  containment: false,
  instanceId: INTENT_ID,
});
const REF_B = encodeCloudflareProviderRef({
  sandboxId: ALLOCATION_B,
  containment: false,
  instanceId: INTENT_ID,
});
const LOGICAL_REF = encodeCloudflareProviderRef({
  sandboxId: LOGICAL_ID,
  containment: false,
  instanceId: INTENT_ID,
});

const billing = parseSandboxBillingInput({
  sandboxId: LOGICAL_ID,
  subject: { type: 'user', id: 'owner_1' },
  actor: { type: 'user', id: 'owner_1' },
  sessionId: 'workspace_1',
  metadata: { origin: 'cloud-agent' },
});

function makeIntent(overrides: Partial<ProviderCreateIntent> = {}): ProviderCreateIntent {
  return {
    intentId: INTENT_ID,
    createdAt: NOW,
    allocationName: ALLOCATION_A,
    ...overrides,
  };
}

function createStub() {
  return {
    launchWrapper: vi.fn(async (_input: unknown) => ({ started: true })),
    observe: vi.fn(
      async (_ref: string): Promise<ContainersObservation> => ({
        running: true,
        state: 'running',
        currentAllocationRef: REF_A,
      })
    ),
    stop: vi.fn(async (_ref: string): Promise<'terminal' | 'retryable'> => 'terminal'),
    ensureLeaseAtLeast: vi.fn(async (_ref: string, _ms: number): Promise<void> => undefined),
    readLog: vi.fn(async (_ref: string, _path: string, _bytes: number): Promise<string> => ''),
    isBillingBlocked: vi.fn(async (): Promise<boolean> => false),
    ensureBillingAdmission: vi.fn(
      async (
        _input: unknown,
        _instance?: ContainerInstanceSize
      ): Promise<SandboxBillingAdmissionResult> => ({ success: true })
    ),
    configureBilling: vi.fn(
      async (_input: unknown, _instance?: ContainerInstanceSize): Promise<void> => undefined
    ),
  };
}

type FakeStub = ReturnType<typeof createStub>;

function asStub(stub: FakeStub): DurableObjectStub<SandboxContainers> {
  return stub as unknown as DurableObjectStub<SandboxContainers>;
}

function setup(
  options: {
    stub?: FakeStub;
    logicalSandboxId?: string;
    allocationName?: string;
    instance?: ContainerInstanceSize;
  } = {}
) {
  const stub = options.stub ?? createStub();
  const getContainer = vi.fn((_logicalSandboxId: string) => asStub(stub));
  const adapter = createCloudflareContainersProviderAdapter({
    logicalSandboxId: options.logicalSandboxId ?? LOGICAL_ID,
    allocationName: options.allocationName ?? ALLOCATION_A,
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    getContainer,
  });
  return { adapter, stub, getContainer };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cloudflare containers provider create', () => {
  it('is not resumable', () => {
    const { adapter } = setup();
    expect(adapter.resumable).toBe(false);
  });

  it('encodes the allocation without touching the container before launch', async () => {
    const { adapter, stub, getContainer } = setup();

    await expect(adapter.create(makeIntent())).resolves.toEqual({ providerRef: REF_A });

    expect(getContainer).not.toHaveBeenCalled();
    expect(stub.launchWrapper).not.toHaveBeenCalled();
  });

  it('creates with worktree-scoped but uncontained requirements', async () => {
    const containment = getWorktreeCredentialContainment(false);
    expect(containment).toEqual({ kilocode: false, github: false, worktreeScoped: true });
    const { adapter } = setup();

    const created = await adapter.create(makeIntent({ containment }));
    if (!('providerRef' in created)) throw new Error('expected an allocation');

    expect(decodeCloudflareProviderRef(created.providerRef)).toEqual({
      sandboxId: ALLOCATION_A,
      containment: false,
      instanceId: INTENT_ID,
    });
  });

  it.each([
    ['worktree containment', getWorktreeCredentialContainment(true)],
    ['kilocode requirement', { kilocode: true, github: false }],
    ['github requirement', { kilocode: false, github: true }],
  ])('encodes %s into the provider reference', async (_label, containment) => {
    const { adapter, getContainer } = setup();

    const created = await adapter.create(makeIntent({ containment }));
    if (!('providerRef' in created)) throw new Error('expected an allocation');

    expect(decodeCloudflareProviderRef(created.providerRef)).toEqual({
      sandboxId: ALLOCATION_A,
      containment: true,
      instanceId: INTENT_ID,
    });
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('resolved default instance admits standard-4 through the DO and startup uses standard-4', async () => {
    const { adapter, stub } = setup();

    await expect(
      adapter.create(makeIntent({ billing: { ...billing, enforcementRequested: true } }))
    ).resolves.toEqual({ providerRef: REF_A });

    expect(stub.ensureBillingAdmission).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sandboxId: LOGICAL_ID, enforcementRequested: true }),
      CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE
    );
    expect(stub.configureBilling).not.toHaveBeenCalled();

    await adapter.launch(REF_A, {});
    expect(stub.launchWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE })
    );
  });

  it('a real insufficient_credits rejection surfaces as billing_blocked', async () => {
    const { adapter, stub } = setup();
    stub.ensureBillingAdmission.mockResolvedValue({
      success: false,
      code: 'insufficient_credits',
      message: 'Insufficient credits',
    });

    await expect(
      adapter.create(makeIntent({ billing: { ...billing, enforcementRequested: true } }))
    ).rejects.toMatchObject({
      name: 'AgentSandboxUnavailableError',
      failure: 'billing_blocked',
    });
  });

  it('normalizes a rejected admission RPC to a temporary unavailability failure', async () => {
    const { adapter, stub } = setup();
    stub.ensureBillingAdmission.mockRejectedValue(new Error('meter rpc exploded'));

    await expect(
      adapter.create(makeIntent({ billing: { ...billing, enforcementRequested: true } }))
    ).rejects.toMatchObject({
      name: 'AgentSandboxUnavailableError',
      failure: 'billing_blocked',
      message: 'Container billing admission is temporarily unavailable',
    });
  });

  it('configures shadow billing when enforcement is not requested', async () => {
    const { adapter, stub } = setup();

    await expect(adapter.create(makeIntent({ billing }))).resolves.toEqual({ providerRef: REF_A });

    expect(stub.configureBilling).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sandboxId: LOGICAL_ID }),
      CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE
    );
    expect(stub.ensureBillingAdmission).not.toHaveBeenCalled();
  });

  it('admits through the DO when a persisted billing block is set without enforcement', async () => {
    const { adapter, stub } = setup();
    stub.isBillingBlocked.mockResolvedValue(true);

    await expect(adapter.create(makeIntent({ billing }))).resolves.toEqual({ providerRef: REF_A });

    expect(stub.ensureBillingAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: LOGICAL_ID }),
      CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE
    );
    expect(stub.configureBilling).not.toHaveBeenCalled();
  });

  it('resolves when billing enforcement is not requested', async () => {
    const { adapter } = setup();

    await expect(adapter.create(makeIntent({ billing }))).resolves.toEqual({ providerRef: REF_A });
  });
});

describe('cloudflare containers provider launch', () => {
  it('launches with the encoded reference and control wrapper environment', async () => {
    const { adapter, stub, getContainer } = setup();

    await adapter.launch(REF_A, { FOO: 'bar' });

    expect(getContainer).toHaveBeenCalledWith(LOGICAL_ID);
    expect(stub.launchWrapper).toHaveBeenCalledWith({
      allocationRef: REF_A,
      containment: false,
      instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      env: {
        FOO: 'bar',
        CONTROL_WORKLOAD_LIMIT_MB: '12288',
        PROVIDER_INSTANCE_ID: REF_A,
        WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
      },
    });
  });

  it('derives the workload limit from the selected container instance', async () => {
    const { adapter, stub } = setup({ instance: 'standard-3' });

    await adapter.launch(REF_A, {});

    expect(stub.launchWrapper).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ CONTROL_WORKLOAD_LIMIT_MB: '8192' }),
      })
    );
  });

  it('keeps a caller-supplied workload limit', async () => {
    const { adapter, stub } = setup();

    await adapter.launch(REF_A, { CONTROL_WORKLOAD_LIMIT_MB: '4096' });

    expect(stub.launchWrapper).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ CONTROL_WORKLOAD_LIMIT_MB: '4096' }),
      })
    );
  });

  it('launches the selected container instance when one is configured', async () => {
    const { adapter, stub } = setup({ instance: 'standard-3' });

    await adapter.launch(REF_A, {});

    expect(stub.launchWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ instance: 'standard-3' })
    );
  });

  it('rejects a reference for an allocation that is not the current one', async () => {
    const { adapter, stub } = setup({ allocationName: ALLOCATION_A });

    await expect(adapter.launch(REF_B, {})).rejects.toThrow(
      'Invalid Cloudflare containers allocation'
    );

    expect(stub.launchWrapper).not.toHaveBeenCalled();
  });

  it('launches a contained reference with outbound containment', async () => {
    const { adapter, stub } = setup();
    const contained = encodeCloudflareProviderRef({
      sandboxId: ALLOCATION_A,
      containment: true,
      instanceId: INTENT_ID,
    });

    await adapter.launch(contained, {});

    expect(stub.launchWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ allocationRef: contained, containment: true })
    );
  });

  it('propagates a DO allocation conflict', async () => {
    const { adapter, stub } = setup();
    stub.launchWrapper.mockRejectedValue(new Error('allocation_conflict'));

    await expect(adapter.launch(REF_A, {})).rejects.toThrow('allocation_conflict');
  });
});

describe('cloudflare containers provider container resolution', () => {
  it('resolves one DO by logical id across two allocations', async () => {
    const stub = createStub();
    const getContainer = vi.fn((_logicalSandboxId: string) => asStub(stub));
    const first = createCloudflareContainersProviderAdapter({
      logicalSandboxId: LOGICAL_ID,
      allocationName: ALLOCATION_A,
      instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      getContainer,
    });
    const second = createCloudflareContainersProviderAdapter({
      logicalSandboxId: LOGICAL_ID,
      allocationName: ALLOCATION_B,
      instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      getContainer,
    });

    const createdFirst = await first.create(makeIntent({ allocationName: ALLOCATION_A }));
    const createdSecond = await second.create(
      makeIntent({ allocationName: ALLOCATION_B, intentId: 'intent-2' })
    );
    if (!('providerRef' in createdFirst)) throw new Error('expected an allocation');
    if (!('providerRef' in createdSecond)) throw new Error('expected an allocation');

    await first.launch(createdFirst.providerRef, {});
    await second.launch(createdSecond.providerRef, {});

    expect(getContainer).toHaveBeenCalledTimes(2);
    for (const call of getContainer.mock.calls) {
      expect(call[0]).toBe(LOGICAL_ID);
    }
    expect(stub.launchWrapper).toHaveBeenCalledTimes(2);
  });
});

describe('cloudflare containers provider observe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  const rows: Array<{
    state: ContainersObservation['state'];
    running: boolean;
    currentAllocationRef: string | null;
    expected: ObserveResult;
  }> = [
    { state: 'idle', running: false, currentAllocationRef: null, expected: 'terminal' },
    { state: 'idle', running: false, currentAllocationRef: REF_B, expected: 'terminal' },
    { state: 'idle', running: true, currentAllocationRef: null, expected: 'unknown' },
    { state: 'stopping', running: true, currentAllocationRef: REF_A, expected: 'unknown' },
    { state: 'launching', running: true, currentAllocationRef: REF_B, expected: 'unknown' },
    { state: 'running', running: true, currentAllocationRef: REF_B, expected: 'unknown' },
    { state: 'launching', running: false, currentAllocationRef: REF_A, expected: 'unknown' },
    { state: 'running', running: false, currentAllocationRef: REF_A, expected: 'unknown' },
    { state: 'launching', running: true, currentAllocationRef: REF_A, expected: 'active' },
    { state: 'running', running: true, currentAllocationRef: REF_A, expected: 'active' },
  ];

  it.each(rows)(
    'maps $state running=$running owner=$currentAllocationRef to $expected',
    async ({ state, running, currentAllocationRef, expected }) => {
      const { adapter, stub } = setup();
      stub.observe.mockResolvedValue({ state, running, currentAllocationRef });

      await expect(adapter.observe(REF_A)).resolves.toEqual({
        status: expected,
        providerRef: REF_A,
      });
    }
  );

  it('holds an idle container unknown inside create settle and terminal past it', async () => {
    const { adapter, stub } = setup();
    stub.observe.mockResolvedValue({ state: 'idle', running: false, currentAllocationRef: null });

    await expect(adapter.observe(REF_A, makeIntent({ createdAt: NOW }))).resolves.toEqual({
      status: 'unknown',
      providerRef: REF_A,
    });
    await expect(
      adapter.observe(REF_A, makeIntent({ createdAt: NOW - DEADLINE_MS.createSettle }))
    ).resolves.toEqual({ status: 'terminal', providerRef: REF_A });
  });

  it('keeps a failed observation unknown with the reference', async () => {
    const { adapter, stub } = setup();
    stub.observe.mockRejectedValue(new Error('container observation failed'));

    await expect(adapter.observe(REF_A)).resolves.toEqual({
      status: 'unknown',
      providerRef: REF_A,
    });
  });

  it('encodes the retained intent for a null reference', async () => {
    const { adapter, stub } = setup();
    stub.observe.mockResolvedValue({
      running: true,
      state: 'running',
      currentAllocationRef: REF_A,
    });

    await expect(adapter.observe(null, makeIntent())).resolves.toEqual({
      status: 'active',
      providerRef: REF_A,
    });

    expect(stub.observe).toHaveBeenCalledWith(REF_A);
  });

  it('falls back to the logical id when the intent has no allocation name', async () => {
    const { adapter, stub } = setup();
    stub.observe.mockResolvedValue({
      running: true,
      state: 'running',
      currentAllocationRef: LOGICAL_REF,
    });

    await expect(adapter.observe(null, makeIntent({ allocationName: undefined }))).resolves.toEqual(
      { status: 'active', providerRef: LOGICAL_REF }
    );

    expect(stub.observe).toHaveBeenCalledWith(LOGICAL_REF);
  });

  it('returns unknown without a DO call when there is no reference or intent', async () => {
    const { adapter, getContainer } = setup();

    await expect(adapter.observe(null)).resolves.toEqual({ status: 'unknown' });

    expect(getContainer).not.toHaveBeenCalled();
  });
});

describe('cloudflare containers provider stop', () => {
  it('maps the DO stop result back through the encoded reference', async () => {
    const { adapter, stub } = setup();
    stub.stop.mockResolvedValueOnce('terminal').mockResolvedValueOnce('retryable');

    await expect(adapter.stop(REF_A)).resolves.toBe('terminal');
    await expect(adapter.stop(REF_A)).resolves.toBe('retryable');

    expect(stub.stop).toHaveBeenCalledWith(REF_A);
  });

  it('returns retryable when the DO stop throws', async () => {
    const { adapter, stub } = setup();
    stub.stop.mockRejectedValue(new Error('destroy failed'));

    await expect(adapter.stop(REF_A)).resolves.toBe('retryable');
  });

  it('returns retryable without a DO call for a malformed reference', async () => {
    const { adapter, getContainer } = setup();

    await expect(adapter.stop('not-json')).resolves.toBe('retryable');

    expect(getContainer).not.toHaveBeenCalled();
  });

  it('returns retryable without a DO call for a reference owned by another allocation', async () => {
    const { adapter, stub, getContainer } = setup({ allocationName: ALLOCATION_A });

    await expect(adapter.stop(REF_B)).resolves.toBe('retryable');

    expect(getContainer).not.toHaveBeenCalled();
    expect(stub.stop).not.toHaveBeenCalled();
  });

  it('stops a contained reference through the container', async () => {
    const { adapter, stub } = setup();
    const contained = encodeCloudflareProviderRef({
      sandboxId: ALLOCATION_A,
      containment: true,
      instanceId: INTENT_ID,
    });

    await expect(adapter.stop(contained)).resolves.toBe('terminal');

    expect(stub.stop).toHaveBeenCalledWith(contained);
  });

  it('resolves a null reference through the retained intent', async () => {
    const { adapter, stub } = setup();

    await expect(adapter.stop(null, makeIntent())).resolves.toBe('terminal');

    expect(stub.stop).toHaveBeenCalledWith(REF_A);
  });

  it('returns retryable without a DO call when there is no reference or intent', async () => {
    const { adapter, getContainer } = setup();

    await expect(adapter.stop(null)).resolves.toBe('retryable');

    expect(getContainer).not.toHaveBeenCalled();
  });
});

describe('cloudflare containers provider lease and logs', () => {
  it('delegates the lease to the DO by logical id', async () => {
    const { adapter, stub, getContainer } = setup();

    await adapter.ensureLeaseAtLeast(REF_A, 360_000);

    expect(getContainer).toHaveBeenCalledWith(LOGICAL_ID);
    expect(stub.ensureLeaseAtLeast).toHaveBeenCalledWith(REF_A, 360_000);
  });

  it('does not call the DO for a malformed lease reference', async () => {
    const { adapter, getContainer } = setup();

    await adapter.ensureLeaseAtLeast('not-json', 360_000);

    expect(getContainer).not.toHaveBeenCalled();
  });

  it('reads the wrapper log through the DO', async () => {
    const { adapter, stub, getContainer } = setup();
    stub.readLog.mockResolvedValue('log-bytes');

    await expect(adapter.logs(REF_A)).resolves.toBe('log-bytes');

    expect(getContainer).toHaveBeenCalledWith(LOGICAL_ID);
    expect(stub.readLog).toHaveBeenCalledWith(REF_A, CONTROL_WRAPPER_LOG_PATH, 1024 * 1024);
  });

  it('returns a textual fallback when the DO read throws', async () => {
    const { adapter, stub } = setup();
    stub.readLog.mockRejectedValue(new Error('container unavailable'));

    await expect(adapter.logs(REF_A)).resolves.toBe(
      `cloudflare-containers ${REF_A} logs unavailable`
    );
  });

  it('returns a textual fallback without a DO call for a malformed reference', async () => {
    const { adapter, getContainer } = setup();

    await expect(adapter.logs('not-json')).resolves.toBe('cloudflare-containers not-json');

    expect(getContainer).not.toHaveBeenCalled();
  });
});
