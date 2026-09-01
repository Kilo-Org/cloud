import { z } from 'zod';
import {
  configureSandboxBillingInput,
  ensureSandboxBillingAdmissionInput,
  isSandboxBillingBlocked,
  isSandboxContainerRunning,
  parseSandboxBillingInput,
} from '../container-usage-context.js';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import { MANAGED_SCM_OUTBOUND_HANDLER } from '../sandbox-id.js';
import type { SandboxInstance } from '../types.js';
import { DEADLINE_MS } from './deadlines.js';
import type { CreateIntent } from './physical-lifecycle.js';
import type { ProviderAdapter, ProviderCreateIntent } from './provider.js';

const CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-wrapper.js';
const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';

const providerRefSchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    containment: z.boolean(),
    instanceId: z.string().min(1).max(128),
  })
  .strict();

export type CloudflareProviderRef = z.infer<typeof providerRefSchema>;

export function encodeCloudflareProviderRef(ref: CloudflareProviderRef): string {
  return JSON.stringify(ref);
}

export function decodeCloudflareProviderRef(raw: string | null): CloudflareProviderRef | null {
  if (raw === null) return null;
  try {
    const parsed = providerRefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type CloudflareSandboxHandle = SandboxInstance;

type SandboxOptions = { containment: boolean };

export function createCloudflareProviderAdapter(deps: {
  sandboxId: string;
  getSandbox: (id: string, options: SandboxOptions) => CloudflareSandboxHandle;
  destroy: (allocationId: string, options: SandboxOptions) => Promise<void>;
}): ProviderAdapter {
  const decodeOwnedProviderRef = (
    ref: string | null
  ): { sandboxId: string; containment: boolean } | null => {
    if (ref === deps.sandboxId) return { sandboxId: deps.sandboxId, containment: false };
    const parsed = decodeCloudflareProviderRef(ref);
    return parsed?.sandboxId === deps.sandboxId ? parsed : null;
  };
  const resolveProviderRef = (ref: string | null, intent?: CreateIntent | null): string | null => {
    if (ref !== null || !intent) return ref;
    const sandboxId = intent.allocationName ?? deps.sandboxId;
    return intent.containment?.worktreeScoped
      ? encodeCloudflareProviderRef({
          sandboxId,
          containment: intent.containment.kilocode || intent.containment.github,
          instanceId: intent.intentId,
        })
      : sandboxId;
  };
  const ensureBillingAdmission: ProviderAdapter['ensureBillingAdmission'] = async (
    ref,
    billing
  ) => {
    if (!billing) return;
    const parsed = decodeOwnedProviderRef(ref);
    if (!parsed) throw new Error('Invalid Cloudflare sandbox allocation');
    const input = parseSandboxBillingInput({ ...billing, sandboxId: parsed.sandboxId });
    const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
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
      const providerRef = encodeCloudflareProviderRef({
        sandboxId: intent.allocationName ?? deps.sandboxId,
        containment: intent.containment
          ? intent.containment.kilocode || intent.containment.github
          : true,
        instanceId: intent.intentId,
      });
      await ensureBillingAdmission(providerRef, intent.billing);
      return { providerRef };
    },
    async launch(ref, env) {
      const parsed = decodeCloudflareProviderRef(ref);
      if (!parsed || parsed.sandboxId !== deps.sandboxId) {
        throw new Error('Invalid Cloudflare sandbox allocation');
      }
      const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
      if (parsed.containment) await sandbox.setOutboundHandler(MANAGED_SCM_OUTBOUND_HANDLER);
      await sandbox.startProcess(`bun run ${CONTROL_WRAPPER_PATH}`, {
        cwd: '/',
        env: {
          ...env,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        },
      });
    },
    async observe(ref, intent) {
      const providerRef = resolveProviderRef(ref, intent);
      const parsed = decodeOwnedProviderRef(providerRef);
      if (!parsed || !providerRef) return { status: 'unknown' };
      try {
        const running = await isSandboxContainerRunning(
          deps.getSandbox(parsed.sandboxId, { containment: parsed.containment })
        );
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
      const parsed = decodeOwnedProviderRef(resolveProviderRef(ref, intent));
      if (!parsed) return 'retryable';
      try {
        await deps.destroy(parsed.sandboxId, { containment: parsed.containment });
        return 'terminal';
      } catch {
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, _ms) {
      const parsed = decodeOwnedProviderRef(ref);
      if (parsed === null) return;
      return deps
        .getSandbox(parsed.sandboxId, { containment: parsed.containment })
        .renewActivityTimeout();
    },
    async logs(ref) {
      return `cloudflare ${ref}`;
    },
  };
}
