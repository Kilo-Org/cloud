import { describe, expect, it } from 'vitest';
import type { AgentSandboxProvider } from '../types.js';
import type { SandboxInstance } from '../types.js';
import {
  parseSandboxBillingInput,
  type SandboxBillingAdmissionResult,
} from '../container-usage-context.js';
import type {
  ContainersLaunchInput,
  ContainersObservation,
  ContainersStartSource,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import {
  VercelSandboxRestError,
  type ExecuteCommandInput,
  type VercelSandboxCommand,
  type VercelSandboxCreateEnvelope,
  type VercelSandboxSession,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import {
  createCloudflareProviderAdapter,
  encodeCloudflareProviderRef,
} from './cloudflare-provider.js';
import { createCloudflareContainersProviderAdapter } from './cloudflare-containers-provider.js';
import {
  createVercelProviderAdapter,
  encodeVercelProviderRef,
  type VercelControlRestClient,
} from './vercel-provider.js';
import {
  ProviderCreationError,
  type ProviderAdapter,
  type ProviderCreateIntent,
} from './provider.js';
import type { SessionCredentialGrant } from './session-credentials.js';
import { buildControlNetworkPolicy } from './session-credentials.js';
import { CONTROL_SUPERVISOR_PATH, CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { leaseAtLeastMs } from './deadlines.js';
import {
  type RuntimeLaunchProcessProbe,
  type RuntimeLaunchProcessStatus,
  type RuntimeLaunchReceiptReader,
  observeRuntimeLaunchPhase,
} from './runtime-launch-phase.js';
import { runtimeLaunchReceiptPath } from './runtime-launch-receipt.js';
import { runtimeInstallerReasonForCode } from './runtime-release-loader.js';

/**
 * The shared provider-adapter contract, exercised against the three real
 * control-plane adapters (cloudflare, cloudflare-containers, vercel) over
 * hand-written fake backends. Nothing here adapts a provider for the test: the
 * production `createCloudflareProviderAdapter` and friends are the code under
 * test, and the fakes stand in only for the Cloudflare Sandbox binding, the
 * `SandboxContainers` Durable Object and the Vercel REST client. That means each
 * assertion drives the adapter's real ref encoding, ownership check, status
 * mapping and backend call shape, which no mock-call-only test does.
 *
 * The fake backends carry real observable state (running/idle/stopped, admission
 * results, stop outcomes, recorded lease and capture calls) rather than flags,
 * so the adapter is judged on what it would physically do.
 */

const SANDBOX = 'ses-abcdef';
const FOREIGN = 'ses-foreign';
const OWNED_LEASE_MS = 123_456;

const billing = parseSandboxBillingInput({
  sandboxId: SANDBOX,
  subject: { type: 'user', id: 'user-1' },
  actor: { type: 'user', id: 'user-1' },
  sessionId: 'workspace_test',
  metadata: { origin: 'cloud-agent' },
  enforcementRequested: true,
});
/** `createdAt: 0` keeps the create-settle window out of every observe. */
const intent: ProviderCreateIntent = { intentId: 'attempt-1', createdAt: 0, billing };

const vercelConfig: VercelSandboxRuntimeConfig = {
  accessToken: 'token',
  teamId: 'team',
  projectId: 'project',
  snapshotId: 'snapshot',
  runtimeBuildId: 'build',
  runtime: 'node24',
  initialTimeoutMs: 60_000,
  extendDurationMs: 60_000,
};

/**
 * The provider-neutral operations the shared cases use. Each concrete harness
 * implements them over one adapter and its backend's observed state.
 */
type ContractHarness = {
  name: AgentSandboxProvider;
  adapter: ProviderAdapter;
  /** Resolve a fresh owned ref through the adapter's own `create`. */
  create(): Promise<string>;
  /** A decodable ref owned by a different sandbox. */
  foreignRef(): string;
  /** Make `observe` report the sandbox up (`true`) or gone (`false`). */
  setRunning(running: boolean): void;
  /** Make the backend fail the next observe, exercising the unknown path. */
  failObserve(): void;
  /** Make the backend refuse to confirm the stop. */
  failStop(): void;
  /** Make `create` fail with a typed creation cause. */
  failCreate(): void;
  /** The env the adapter passed to the physical launch, if any yet. */
  launchedEnv(): Record<string, string> | undefined;
  /** The supervisor invocation the adapter issued, where it names one explicitly. */
  launchSupervisor(): string | undefined;
  /** Lease attempts the backend received for an owned ref. */
  leaseCalls(): number;
  /** Lease durations the backend received where it has one (Cloudflare has none). */
  leaseMs(): number[];
  /** Containers-only repository capture; absent on the other two adapters. */
  captureRepository?(ref: string, repoKey: string, commit?: string): Promise<boolean>;
  /** Containers-only observable capture call. */
  capturedRepository?(): { ref: string; repoKey: string; commit?: string } | undefined;
  /** Containers-only: set the outcome the backend reports from `stop`. */
  setStopOutcome?(outcome: 'terminal' | 'retryable'): void;
  /** Vercel-only: authoritative contained-grant reads observed by the adapter. */
  grantReads?(): number;
  /** Vercel-only: policy bodies the adapter sent to the backend. */
  appliedPolicies?(): unknown[];
};

async function requireRef(adapter: ProviderAdapter): Promise<string> {
  const created = await adapter.create(intent);
  if (!('providerRef' in created)) throw new Error('create did not resolve a provider ref');
  return created.providerRef;
}

function cloudflareHarness(): ContractHarness {
  const state = {
    running: true,
    observeThrows: false,
    destroyThrows: false,
    admission: async (): Promise<SandboxBillingAdmissionResult> => ({ success: true }),
    startEnvs: [] as Record<string, string>[],
    startPaths: [] as string[],
    leaseCalls: 0,
  };
  const sandbox = {
    isContainerRunning: async () => {
      if (state.observeThrows) throw new Error('cloudflare inspect failed');
      return state.running;
    },
    isBillingBlocked: async () => false,
    ensureBillingAdmission: () => state.admission(),
    configureBilling: async () => {},
    setOutboundHandler: async () => {},
    startProcess: async (path: string, options?: { env?: Record<string, string> }) => {
      state.startPaths.push(path);
      state.startEnvs.push(options?.env ?? {});
    },
    renewActivityTimeout: async () => {
      state.leaseCalls += 1;
    },
  } as unknown as SandboxInstance;
  const adapter = createCloudflareProviderAdapter({
    sandboxId: SANDBOX,
    getSandbox: () => sandbox,
    destroy: async () => {
      if (state.destroyThrows) throw new Error('cloudflare destroy failed');
    },
  });
  return {
    name: 'cloudflare',
    adapter,
    create: () => requireRef(adapter),
    foreignRef: () =>
      encodeCloudflareProviderRef({ sandboxId: FOREIGN, containment: false, instanceId: 'x' }),
    setRunning: running => {
      state.running = running;
    },
    failObserve: () => {
      state.observeThrows = true;
    },
    failStop: () => {
      state.destroyThrows = true;
    },
    failCreate: () => {
      state.admission = async () => ({
        success: false,
        code: 'stopping',
        message: 'Sandbox is stopping',
      });
    },
    launchedEnv: () => state.startEnvs.at(-1),
    launchSupervisor: () => state.startPaths.at(-1),
    leaseCalls: () => state.leaseCalls,
    leaseMs: () => [],
  };
}

function containersHarness(
  options: { startSource?: ContainersStartSource; failLaunchLease?: boolean } = {}
): ContractHarness {
  const state = {
    observation: {
      running: true,
      state: 'running',
      currentAllocationRef: null,
    } as ContainersObservation,
    observeThrows: false,
    stopThrows: false,
    stopResult: 'terminal' as 'terminal' | 'retryable',
    admission: async (): Promise<SandboxBillingAdmissionResult> => ({ success: true }),
    launchInputs: [] as ContainersLaunchInput[],
    leaseMs: [] as number[],
    captures: [] as { ref: string; repoKey: string; commit?: string }[],
  };
  const container = {
    isBillingBlocked: async () => false,
    ensureBillingAdmission: () => state.admission(),
    configureBilling: async () => {},
    launchWrapper: async (input: ContainersLaunchInput) => {
      state.launchInputs.push(input);
      state.observation = { ...state.observation, currentAllocationRef: input.allocationRef };
      return { started: true, startSource: options.startSource ?? 'image' };
    },
    ensureLeaseAtLeast: async (_ref: string, ms: number) => {
      state.leaseMs.push(ms);
      if (options.failLaunchLease) throw new Error('containers lease failed');
    },
    captureRepository: async (ref: string, repoKey: string, commit?: string) => {
      state.captures.push({ ref, repoKey, ...(commit === undefined ? {} : { commit }) });
      return true;
    },
    observe: async () => {
      if (state.observeThrows) throw new Error('containers observe failed');
      return state.observation;
    },
    stop: async () => {
      if (state.stopThrows) throw new Error('containers stop failed');
      return state.stopResult;
    },
    readLog: async () => 'container-log-body',
  } as unknown as DurableObjectStub<SandboxContainers>;
  const adapter = createCloudflareContainersProviderAdapter({
    logicalSandboxId: SANDBOX,
    allocationName: SANDBOX,
    getContainer: () => container,
  });
  return {
    name: 'cloudflare-containers',
    adapter,
    create: async () => {
      const ref = await requireRef(adapter);
      state.observation = { ...state.observation, currentAllocationRef: ref };
      return ref;
    },
    foreignRef: () =>
      encodeCloudflareProviderRef({ sandboxId: FOREIGN, containment: false, instanceId: 'x' }),
    setRunning: running => {
      state.observation = {
        running,
        state: running ? 'running' : 'idle',
        currentAllocationRef: state.observation.currentAllocationRef,
      };
    },
    failObserve: () => {
      state.observeThrows = true;
    },
    failStop: () => {
      state.stopThrows = true;
    },
    failCreate: () => {
      state.admission = async () => ({
        success: false,
        code: 'stopping',
        message: 'Sandbox is stopping',
      });
    },
    launchedEnv: () => state.launchInputs.at(-1)?.env,
    // Containers start the supervisor as the image entrypoint; no path is passed.
    launchSupervisor: () => undefined,
    leaseCalls: () => state.leaseMs.length,
    leaseMs: () => [...state.leaseMs],
    captureRepository: (ref, repoKey, commit) => adapter.captureRepository!(ref, repoKey, commit),
    capturedRepository: () => state.captures.at(-1),
    setStopOutcome: outcome => {
      state.stopResult = outcome;
    },
  };
}
function vercelHarness(): ContractHarness {
  const startedAt = Date.now();
  const state = {
    status: 'running' as VercelSandboxSession['status'],
    stopStatus: 'stopped' as VercelSandboxSession['status'],
    observeThrows: false,
    stopThrows: false,
    createError: undefined as Error | undefined,
    commands: [] as ExecuteCommandInput[],
    extendedMs: [] as number[],
    policies: [] as unknown[],
    grantReads: 0,
  };
  const session = (status: VercelSandboxSession['status']): VercelSandboxSession => ({
    id: 'session-1',
    sourceSandboxName: SANDBOX,
    projectId: 'project',
    runtime: 'node24',
    status,
    memory: 4096,
    vcpus: 2,
    region: 'fra1',
    timeout: 1_000,
    requestedAt: startedAt,
    startedAt,
    cwd: '/',
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const restClient: VercelControlRestClient = {
    createSandbox: async input => {
      if (state.createError) throw state.createError;
      return {
        sandbox: {} as never,
        session: session('running'),
        routes: [],
        runtime: { sandboxName: input.name, sessionId: 'session-1' },
      } satisfies VercelSandboxCreateEnvelope;
    },
    inspectByName: async () => null,
    getSession: async () => {
      if (state.observeThrows) throw new Error('vercel observe failed');
      return { session: session(state.status), routes: [] };
    },
    executeCommand: async (_sessionId, input) => {
      state.commands.push(input);
      return {
        id: 'command-1',
        name: input.command,
        args: input.args,
        cwd: input.cwd ?? '/',
        sessionId: 'session-1',
        exitCode: null,
        startedAt,
      } satisfies VercelSandboxCommand;
    },
    extendSessionTimeout: async (_sessionId, _sandboxName, durationMs) => {
      state.extendedMs.push(durationMs);
      return session('running');
    },
    stopSession: async () => {
      if (state.stopThrows) throw new Error('vercel stop failed');
      return session(state.stopStatus);
    },
    readFile: async () => new TextEncoder().encode('vercel-log-body'),
    updateNetworkPolicy: async (_sessionId, _sandboxName, policy) => {
      state.policies.push(policy);
      return session('running');
    },
  };
  const adapter = createVercelProviderAdapter({
    sandboxName: SANDBOX,
    config: vercelConfig,
    restClient,
    readContainedGrants: async () => {
      state.grantReads += 1;
      return [];
    },
  });
  return {
    name: 'vercel',
    adapter,
    create: () => requireRef(adapter),
    foreignRef: () => encodeVercelProviderRef({ sandboxName: FOREIGN, sessionId: 'session-x' }),
    setRunning: running => {
      state.status = running ? 'running' : 'stopped';
    },
    failObserve: () => {
      state.observeThrows = true;
    },
    failStop: () => {
      state.stopThrows = true;
    },
    failCreate: () => {
      state.createError = new VercelSandboxRestError('invalid_request', 'create', 400);
    },
    launchedEnv: () => state.commands.at(-1)?.env,
    launchSupervisor: () => state.commands.at(-1)?.args.at(-1),
    leaseCalls: () => state.extendedMs.length,
    leaseMs: () => [...state.extendedMs],
    grantReads: () => state.grantReads,
    appliedPolicies: () => [...state.policies],
  };
}

const harnessFactories = [cloudflareHarness, containersHarness, vercelHarness];

describe.each(harnessFactories.map(factory => [factory().name, factory] as const))(
  'provider adapter contract: %s',
  (_name, factory) => {
    it('projects owned runtime identity without querying the backend', async () => {
      const harness = factory();
      const ref = await harness.create();
      harness.failObserve();
      harness.failCreate();
      const container = harness.adapter.describeRuntime?.(ref);
      expect(container).toEqual({
        provider: harness.name,
        sandboxId: SANDBOX,
        instanceId: harness.name === 'vercel' ? 'session-1' : intent.intentId,
        ...(harness.name === 'vercel'
          ? {
              region: 'fra1',
              instanceType: 'small',
              snapshotId: 'snapshot',
              runtimeBuildId: 'build',
              startSource: 'snapshot',
            }
          : harness.name === 'cloudflare'
            ? { startSource: 'image' }
            : { instanceType: 'standard-3' }),
      });
      expect(harness.adapter.describeRuntime?.(harness.foreignRef())).toBeUndefined();
      expect(harness.adapter.describeRuntime?.('invalid')).toBeUndefined();
    });

    it('creates a ref, then launch maps the ref, caller env and supervisor', async () => {
      const harness = factory();
      const ref = await harness.create();

      const launched = await harness.adapter.launch(ref, { CALLER: 'value' });

      expect(launched).toEqual({ startSource: 'image' });
      expect(harness.launchedEnv()).toMatchObject({
        CALLER: 'value',
        PROVIDER_INSTANCE_ID: ref,
        WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
      });
      expect(harness.launchedEnv()?.WRAPPER_LOG_PATH).toBe('/tmp/kilocode-control-wrapper.log');
    });

    it('observes an owned ref active, then terminal once the backend reports it gone', async () => {
      const harness = factory();
      const ref = await harness.create();

      harness.setRunning(true);
      await expect(harness.adapter.observe(ref, intent)).resolves.toMatchObject({
        status: 'active',
      });

      harness.setRunning(false);
      await expect(harness.adapter.observe(ref, intent)).resolves.toMatchObject({
        status: 'terminal',
      });
    });

    it('observes a backend failure as unknown, not as a lost sandbox', async () => {
      const harness = factory();
      const ref = await harness.create();

      harness.failObserve();
      await expect(harness.adapter.observe(ref, intent)).resolves.toMatchObject({
        status: 'unknown',
      });
    });

    it('stops an owned ref as terminal when the backend confirms', async () => {
      const harness = factory();
      const ref = await harness.create();

      await expect(harness.adapter.stop(ref)).resolves.toBe('terminal');
    });

    it('reports a retryable stop when the backend has not confirmed', async () => {
      const harness = factory();
      const ref = await harness.create();

      harness.failStop();
      await expect(harness.adapter.stop(ref)).resolves.toBe('retryable');
    });

    it('refuses a foreign ref for launch, observe and stop', async () => {
      const harness = factory();

      await expect(harness.adapter.launch(harness.foreignRef(), {})).rejects.toBeInstanceOf(
        ProviderCreationError
      );
      await expect(harness.adapter.observe(harness.foreignRef(), intent)).resolves.toMatchObject({
        status: 'unknown',
      });
      await expect(harness.adapter.stop(harness.foreignRef())).resolves.toBe('retryable');
    });

    it('renews the lease for an owned ref', async () => {
      const harness = factory();
      const ref = await harness.create();

      await harness.adapter.ensureLeaseAtLeast(ref, OWNED_LEASE_MS);
      expect(harness.leaseCalls()).toBeGreaterThan(0);
    });

    it('returns non-empty logs for an owned ref', async () => {
      const harness = factory();
      const ref = await harness.create();

      await expect(harness.adapter.logs(ref)).resolves.toEqual(expect.any(String));
      expect((await harness.adapter.logs(ref)).length).toBeGreaterThan(0);
    });

    it('surfaces a typed creation error', async () => {
      const harness = factory();
      harness.failCreate();

      await expect(harness.create()).rejects.toBeInstanceOf(ProviderCreationError);
    });
  }
);

describe('provider-specific contract differences', () => {
  it('reports the actual snapshot launch source even if its initial lease renewal fails', async () => {
    const harness = containersHarness({ startSource: 'repository', failLaunchLease: true });
    const ref = await harness.create();
    await expect(harness.adapter.launch(ref, {})).resolves.toEqual({ startSource: 'repository' });
    expect(harness.leaseCalls()).toBe(1);
  });

  it('keeps Cloudflare logs as an opaque descriptor and ignores the lease duration', async () => {
    const harness = cloudflareHarness();
    const ref = await harness.create();

    await harness.adapter.launch(ref, {});
    expect(harness.launchSupervisor()).toBe(CONTROL_SUPERVISOR_PATH);
    expect(await harness.adapter.logs(ref)).toBe(`cloudflare ${ref}`);
    await harness.adapter.ensureLeaseAtLeast(ref, OWNED_LEASE_MS);
    // Cloudflare renews its activity timeout with no duration argument.
    expect(harness.leaseMs()).toEqual([]);
    const owned = harness.leaseCalls();
    await harness.adapter.ensureLeaseAtLeast(harness.foreignRef(), OWNED_LEASE_MS);
    expect(harness.leaseCalls()).toBe(owned);
    expect('captureRepository' in harness.adapter).toBe(false);
    expect('applyContainedCredentials' in harness.adapter).toBe(false);
  });

  it('maps Containers repository capture and reports a backend stop outcome verbatim', async () => {
    const harness = containersHarness();
    const ref = await harness.create();

    expect(await harness.captureRepository!(ref, 'repo-key', 'commit-1')).toBe(true);
    expect(harness.capturedRepository!()).toEqual({
      ref,
      repoKey: 'repo-key',
      commit: 'commit-1',
    });
    expect(await harness.captureRepository!(harness.foreignRef(), 'repo-key')).toBe(false);

    await harness.adapter.ensureLeaseAtLeast(ref, OWNED_LEASE_MS);
    expect(harness.leaseMs()).toEqual([OWNED_LEASE_MS]);
    expect(await harness.adapter.logs(ref)).toBe('container-log-body');
    // The DO reports an unconfirmed stop outcome, and the adapter returns it verbatim.
    harness.setStopOutcome!('retryable');
    expect(await harness.adapter.stop(ref)).toBe('retryable');
    // The adapter delegates foreign-ref ownership to the DO, which fences the
    // lease on its own running allocation; the call still reaches the backend.
    const owned = harness.leaseMs().length;
    await harness.adapter.ensureLeaseAtLeast(harness.foreignRef(), OWNED_LEASE_MS);
    expect(harness.leaseMs()).toHaveLength(owned + 1);
    expect('applyContainedCredentials' in harness.adapter).toBe(false);
  });

  it('maps Containers launch with the leased instance and supervisor env', async () => {
    const harness = containersHarness();
    const ref = await harness.create();

    await harness.adapter.launch(ref, { CALLER: 'value' });

    expect(harness.launchedEnv()).toMatchObject({
      CALLER: 'value',
      CONTROL_WORKLOAD_LIMIT_MB: '8192',
      PROVIDER_INSTANCE_ID: ref,
      WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
    });
    // The launch establishes the initial lease at the shared minimum.
    expect(harness.leaseMs()).toEqual([leaseAtLeastMs()]);
    expect(harness.launchSupervisor()).toBeUndefined();
  });

  it('reads Vercel grants on every create and applies a contained-credential policy', async () => {
    const harness = vercelHarness();
    const ref = await harness.create();
    // Creation reads the authoritative grants exactly once, even when empty.
    expect(harness.grantReads!()).toBe(1);

    await harness.adapter.launch(ref, {});
    expect(harness.launchSupervisor()).toContain(`exec ${CONTROL_SUPERVISOR_PATH}`);
    expect('applyContainedCredentials' in harness.adapter).toBe(true);
    // A foreign ref is refused before any Vercel request.
    const leases = harness.leaseMs().length;
    await harness.adapter.ensureLeaseAtLeast(harness.foreignRef(), OWNED_LEASE_MS);
    expect(harness.leaseMs()).toHaveLength(leases);
    expect('captureRepository' in harness.adapter).toBe(false);

    await expect(
      harness.adapter.applyContainedCredentials!(ref, [] as readonly SessionCredentialGrant[])
    ).resolves.toBeUndefined();
    // The policy the adapter sent is the one built from the grants.
    expect(harness.appliedPolicies!()).toEqual([buildControlNetworkPolicy([])]);
    await expect(
      harness.adapter.applyContainedCredentials!(
        harness.foreignRef(),
        [] as readonly SessionCredentialGrant[]
      )
    ).rejects.toThrow(/Invalid Vercel sandbox provider reference/);
  });
});

/**
 * The Cloudflare SDK launch phase. `startProcess` returns a snapshot whose
 * `exitCode` is unset, so the phase reads the receipt and a bounded fresh
 * `getProcess` DTO. `waitForExit` is never used: its SSE stream does not cancel
 * on timeout. The metadata preflight is covered by the loader Workers test;
 * these cases prove the phase contract.
 */
describe('cloudflare runtime launch phase', () => {
  const LAUNCH_ID = 'launch-0001';
  const DEADLINE = 10_000;
  const asReceipt = (body: unknown) => JSON.stringify(body);
  const handoff = asReceipt({ launchId: LAUNCH_ID, outcome: 'handoff' });
  const failed = (code: number) =>
    asReceipt({ launchId: LAUNCH_ID, outcome: 'installer_failed', code });

  /** A reader that returns each content once, then repeats the last. */
  function readerWith(...contents: readonly (string | undefined)[]): RuntimeLaunchReceiptReader {
    let call = 0;
    return {
      async readFile(path) {
        if (path !== runtimeLaunchReceiptPath(LAUNCH_ID)) throw new Error('not found');
        const content = contents[Math.min(call, contents.length - 1)];
        call += 1;
        if (content === undefined) throw new Error('not found');
        return { success: true, content };
      },
    };
  }

  type Info = { status: RuntimeLaunchProcessStatus; exitCode?: number } | null;
  const running: Info = { status: 'running' };
  const terminal = (code: number): Info => ({ status: 'completed', exitCode: code });
  /** A terminal DTO that omits the exit code (killed / errored / completed). */
  const terminalUnknown = (status: RuntimeLaunchProcessStatus = 'killed'): Info => ({ status });

  /** A probe that returns each DTO once, then repeats the last. */
  function probeWith(...infos: readonly Info[]): RuntimeLaunchProcessProbe {
    let call = 0;
    return {
      async getProcess() {
        const info = infos[Math.min(call, infos.length - 1)];
        call += 1;
        return info;
      },
    };
  }

  const noClock = () => ({ now: () => 0, sleep: async () => undefined });

  it('returns on a handoff receipt without waiting for the supervisor', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(handoff),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'handoff' });
  });

  it('reads a handoff before a later supervisor exit, so an exit 73 is not an artifact failure', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(handoff),
      probeWith(terminal(73)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'handoff' });
  });

  it('returns a valid installer failure receipt by itself, without a terminal DTO', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(failed(77)),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'installer-failed', code: 77 });
    if (outcome.kind === 'installer-failed') {
      expect(runtimeInstallerReasonForCode(outcome.code)).toBe('runtime_supervisor_missing');
    }
  });

  it('reads a valid current receipt before the clock: a running process with code 71 is unauthorized, not deadline', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(failed(71)),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      { now: () => DEADLINE + 292, sleep: async () => undefined }
    );
    expect(outcome).toEqual({ kind: 'installer-failed', code: 71 });
    if (outcome.kind === 'installer-failed') {
      expect(runtimeInstallerReasonForCode(outcome.code)).toBe('runtime_artifact_unauthorized');
    }
  });

  it('does not let a disagreeing terminal DTO override a valid receipt', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(failed(71)),
      probeWith(terminal(70)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'installer-failed', code: 71 });
  });

  it('owns the deadline reason at the clock, even for an installer deadline code', async () => {
    const code75 = await observeRuntimeLaunchPhase(
      readerWith(failed(75)),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(code75).toEqual({ kind: 'deadline' });

    const noReceipt = await observeRuntimeLaunchPhase(
      readerWith(undefined),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      { now: () => DEADLINE, sleep: async () => undefined }
    );
    expect(noReceipt).toEqual({ kind: 'deadline' });
  });

  it('owns the deadline when the receipt stays stale or invalid to the clock', async () => {
    const stale = await observeRuntimeLaunchPhase(
      readerWith(asReceipt({ launchId: 'someone-else', outcome: 'installer_failed', code: 71 })),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      { now: () => DEADLINE, sleep: async () => undefined }
    );
    expect(stale).toEqual({ kind: 'deadline' });

    const invalid = await observeRuntimeLaunchPhase(
      readerWith('{"launchId":"launch-00'),
      probeWith(running),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      { now: () => DEADLINE, sleep: async () => undefined }
    );
    expect(invalid).toEqual({ kind: 'deadline' });
  });

  it('keeps polling a partial (invalid) receipt while running and settles on the final write', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith('{"launchId":"launch-00', failed(73)),
      probeWith(running, running, terminal(73)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'installer-failed', code: 73 });
  });

  it('never infers an artifact reason from a missing, malformed, or id-mismatched receipt', async () => {
    const missing = await observeRuntimeLaunchPhase(
      readerWith(undefined),
      probeWith(terminal(70)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(missing).toEqual({ kind: 'bootstrap-failed' });

    const malformed = await observeRuntimeLaunchPhase(
      readerWith('{not json'),
      probeWith(terminal(73)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(malformed).toEqual({ kind: 'bootstrap-failed' });

    const rawCode = await observeRuntimeLaunchPhase(
      readerWith('73'),
      probeWith(terminal(73)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(rawCode).toEqual({ kind: 'bootstrap-failed' });

    const unknownCode = await observeRuntimeLaunchPhase(
      readerWith(failed(78)),
      probeWith(terminal(78)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(unknownCode).toEqual({ kind: 'bootstrap-failed' });

    const wrongId = await observeRuntimeLaunchPhase(
      readerWith(asReceipt({ launchId: 'someone-else', outcome: 'handoff' })),
      probeWith(terminal(0)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(wrongId).toEqual({ kind: 'bootstrap-failed' });
  });

  it('reports a generic fast failure when the process is terminal but no receipt exists', async () => {
    const outcome = await observeRuntimeLaunchPhase(
      readerWith(undefined),
      probeWith(running, terminal(0)),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(outcome).toEqual({ kind: 'bootstrap-failed' });
  });

  it('lets a valid receipt win over a terminal DTO with no exit code, else fails generically', async () => {
    // A valid receipt is the authority even when the DTO is terminal-unknown.
    const withReceipt = await observeRuntimeLaunchPhase(
      readerWith(failed(71)),
      probeWith(terminalUnknown('killed')),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(withReceipt).toEqual({ kind: 'installer-failed', code: 71 });

    // With no valid receipt, a killed/errored/completed DTO that omits exitCode
    // must not fake an agreed code or stall to the deadline: it fails generically
    // and promptly.
    const withoutReceipt = await observeRuntimeLaunchPhase(
      readerWith(undefined),
      probeWith(running, terminalUnknown('error')),
      'proc',
      LAUNCH_ID,
      DEADLINE,
      noClock()
    );
    expect(withoutReceipt).toEqual({ kind: 'bootstrap-failed' });
  });
});
