import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import type { SandboxControlV2 } from '../../../src/control-plane/sandbox/sandbox-do.js';
import { generateSandboxId } from '../../../src/sandbox-id.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../../src/sandbox-control/provider.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { waitFor } from '../wait-for.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINERS_NAMESPACE,
  installFakeSandboxEnv,
} from './fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './fake-session-peer.js';
import { FakeWrapper } from './fake-wrapper.js';

const sandboxes = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

export type TunnelSandbox = {
  sandboxId: string;
  allocationId: string;
  /** The signed launch credential that the wrapper presents as its bearer token. */
  launchCredential: string;
  stub: DurableObjectStub<SandboxControlV2>;
  wrapper: FakeWrapper;
  demands: () => number;
};

/** A real Sandbox DO with a fake provider, and a fake wrapper bound to its allocation. */
export async function startTunnelSandbox(options: {
  previewTunnel: boolean;
}): Promise<TunnelSandbox> {
  const sandboxId = await generateSandboxId(`workspace_${crypto.randomUUID()}`);
  const provider = createFakeProvider();
  const stub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeSandboxEnv(instance, broker, {
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    installFakeRuntimeProxyPeer(instance);
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
    });
  });
  await stub.ensureAllocation({ provider: 'cloudflare-containers', allocationName: sandboxId });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0]!;
  const launchCredential = launchEnv.SANDBOX_CONTROL_CREDENTIAL!;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID!;
  const wrapper = await FakeWrapper.connect({ sandboxId, credential: launchCredential });
  let demands = 0;
  wrapper.onFrame((frame: ControlPlaneWrapperFrame) => {
    if (frame.type === 'preview.tunnel') demands += 1;
  });
  expect(
    await wrapper.hello({
      wrapperId: 'wr_preview_tunnel',
      allocationId,
      previewTunnel: options.previewTunnel,
    })
  ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
  await waitFor(async () => expect((await stub.getAllocationState()).kind).toBe('connected'));
  return { sandboxId, allocationId, launchCredential, stub, wrapper, demands: () => demands };
}

export function readSandboxAlarm(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}
