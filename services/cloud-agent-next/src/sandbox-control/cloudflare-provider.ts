import {
  configureSandboxBillingInput,
  ensureSandboxBillingAdmissionInput,
  isSandboxBillingBlocked,
  isSandboxContainerRunning,
  parseSandboxBillingInput,
} from '../container-usage-context.js';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import type { SandboxInstance } from '../types.js';
import { DEADLINE_MS } from './deadlines.js';
import type { ProviderAdapter, ProviderCreateIntent } from './provider.js';

const CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-wrapper.js';
const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';

export type CloudflareSandboxHandle = SandboxInstance;

export function createCloudflareProviderAdapter(deps: {
  sandboxId: string;
  getSandbox: (id: string) => CloudflareSandboxHandle;
  destroy: (allocationId: string) => Promise<void>;
}): ProviderAdapter {
  const ensureBillingAdmission: ProviderAdapter['ensureBillingAdmission'] = async (
    ref,
    billing
  ) => {
    if (!billing) return;
    const input = parseSandboxBillingInput({ ...billing, sandboxId: ref });
    const sandbox = deps.getSandbox(ref);
    const blocked = await isSandboxBillingBlocked(sandbox, input.enforcementRequested);
    if (input.enforcementRequested || blocked) {
      const admission = await ensureSandboxBillingAdmissionInput(sandbox, input);
      if (!admission.success) {
        throw new AgentSandboxUnavailableError(
          admission.code === 'insufficient_credits' || admission.code === 'stopping'
            ? 'Container billing requires additional credits'
            : 'Container billing admission is temporarily unavailable',
          'billing_blocked'
        );
      }
    } else {
      await configureSandboxBillingInput(sandbox, input).catch(() => undefined);
    }
  };

  return {
    resumable: false,
    ensureBillingAdmission,
    async create(intent: ProviderCreateIntent) {
      const providerRef = intent.allocationName ?? deps.sandboxId;
      await ensureBillingAdmission(providerRef, intent.billing);
      return { providerRef };
    },
    async launch(ref, env) {
      await deps.getSandbox(ref).startProcess(`bun run ${CONTROL_WRAPPER_PATH}`, {
        cwd: '/',
        env: {
          ...env,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        },
      });
    },
    async observe(ref, intent) {
      const providerRef = ref ?? intent?.allocationName ?? (intent ? deps.sandboxId : undefined);
      if (!providerRef) return { status: 'unknown' };
      try {
        const running = await isSandboxContainerRunning(deps.getSandbox(providerRef));
        const settling = intent && Date.now() < intent.createdAt + DEADLINE_MS.createSettle;
        return {
          status:
            running === true ? 'active' : running === false && !settling ? 'terminal' : 'unknown',
          providerRef,
        };
      } catch {
        return { status: 'unknown', providerRef };
      }
    },
    async stop(ref, intent) {
      const providerRef = ref ?? intent?.allocationName ?? (intent ? deps.sandboxId : undefined);
      if (!providerRef) return 'retryable';
      try {
        await deps.destroy(providerRef);
        return 'terminal';
      } catch {
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, _ms) {
      return deps.getSandbox(ref).renewActivityTimeout();
    },
    async logs(ref) {
      return `cloudflare ${ref}`;
    },
  };
}
