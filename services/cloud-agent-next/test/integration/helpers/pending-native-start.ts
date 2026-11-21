import { env, runInDurableObject } from 'cloudflare:test';
import type { SandboxContainers } from '../../../src/sandbox-containers/SandboxContainers.js';
import { supervisorStartup } from '../../fixtures/supervisor-startup.js';

const namespace = (
  env as unknown as {
    SANDBOX_CONTAINERS: DurableObjectNamespace<SandboxContainers>;
  }
).SANDBOX_CONTAINERS;

/** A real native provider DO with a blocked readiness read and a gated destroy. */
export async function pendingNativeStart() {
  const stub = namespace.getByName('pending-native-start');
  const probe = Promise.withResolvers<void>();
  const destroy = Promise.withResolvers<void>();
  let monitor = Promise.withResolvers<void>();
  const container = {
    running: false,
    images: { 'runtime-free': 'registry.example/runtime-free:test' },
    probes: 0,
    starts: 0,
    destroys: 0,
    start() {
      this.running = true;
      this.starts += 1;
      monitor = Promise.withResolvers<void>();
    },
    async exec() {
      this.probes += 1;
      if (this.probes === 1) await probe.promise;
      return {
        output: async () => ({
          exitCode: 0,
          stdout: new TextEncoder().encode(`${supervisorStartup().argv.join('\0')}\0`),
          stderr: new Uint8Array(),
        }),
      };
    },
    monitor: () => monitor.promise,
    async destroy() {
      this.destroys += 1;
      await destroy.promise;
      this.running = false;
      monitor.resolve();
    },
  };
  await runInDurableObject(stub, (instance, state) => {
    Object.assign(instance, {
      ctx: {
        id: state.id,
        storage: state.storage,
        waitUntil: state.waitUntil.bind(state),
        container,
      },
    });
  });
  return {
    get stub() {
      return namespace.getByName('pending-native-start');
    },
    container,
    releaseProbe: probe.resolve,
    releaseDestroy: destroy.resolve,
  };
}
