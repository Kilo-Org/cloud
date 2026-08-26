import type { ProviderAdapter, ProviderCreateIntent } from './provider.js';

const CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-wrapper.js';
const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';

export type CloudflareSandboxHandle = {
  renewActivityTimeout(): void | Promise<void>;
  destroy(): Promise<void>;
  isContainerRunning?(): Promise<boolean>;
  startProcess(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> }
  ): Promise<unknown>;
};

export function createCloudflareProviderAdapter(deps: {
  sandboxId: string;
  getSandbox: (id: string) => CloudflareSandboxHandle;
}): ProviderAdapter {
  return {
    resumable: false,
    async create(intent: ProviderCreateIntent) {
      const sandbox = deps.getSandbox(deps.sandboxId);
      try {
        await sandbox.startProcess(`bun run ${CONTROL_WRAPPER_PATH}`, {
          cwd: '/',
          env: {
            ...intent.env,
            WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
          },
        });
      } catch {
        // The container exists; SandboxControl must keep the ref to stop it.
      }
      return { providerRef: deps.sandboxId };
    },
    async observe(ref) {
      if (ref === null) return 'terminal';
      try {
        const sandbox = deps.getSandbox(ref);
        if (!sandbox.isContainerRunning) return 'unknown';
        return (await sandbox.isContainerRunning()) ? 'active' : 'terminal';
      } catch {
        return 'unknown';
      }
    },
    async stop(ref) {
      if (ref === null) return 'terminal';
      try {
        await deps.getSandbox(ref).destroy();
        return 'terminal';
      } catch {
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, _ms) {
      await Promise.resolve(deps.getSandbox(ref).renewActivityTimeout());
    },
    async logs(ref) {
      return `cloudflare ${ref}`;
    },
  };
}
