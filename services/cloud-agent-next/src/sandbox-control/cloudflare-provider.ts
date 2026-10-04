import { z } from 'zod';
import type { ExecResult } from '@cloudflare/sandbox';
import { withTimeout } from '@kilocode/worker-utils';
import {
  configureSandboxBillingInput,
  ensureSandboxBillingAdmissionInput,
  isSandboxBillingBlocked,
  isSandboxContainerRunning,
  parseSandboxBillingInput,
} from '../container-usage-context.js';
import { MANAGED_SCM_OUTBOUND_HANDLER } from '../sandbox-id.js';
import type { SandboxInstance } from '../types.js';
import { DEADLINE_MS } from './deadlines.js';
import { logControlDiagnostic } from './diagnostics.js';
import type {
  ProviderAdapter,
  ProviderAllocationIntent,
  ProviderCreateIntent,
} from './provider.js';
import { ProviderCreationError } from './provider.js';
import { CONTROL_SUPERVISOR_PATH, CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { parseWrapperProcScanOutput, WRAPPER_PROC_SCAN_COMMAND } from './wrapper-proc-scan.js';

export const WRAPPER_PROC_PROBE_TIMEOUT_MS = 5_000;

export type CloudflareWrapperProbeResult =
  | { outcome: 'count'; count: number; incomplete: boolean }
  | { outcome: 'unparsed' }
  | { outcome: 'timeout' }
  | { outcome: 'error' }
  | { outcome: 'invalid_reference' };

export type CloudflareProviderAdapter = ProviderAdapter & {
  probeWrapperProcesses(ref: string): Promise<CloudflareWrapperProbeResult>;
};

export function isCloudflareProviderAdapter(
  provider: ProviderAdapter
): provider is CloudflareProviderAdapter {
  return 'probeWrapperProcesses' in provider;
}

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
}): CloudflareProviderAdapter {
  const decodeOwnedProviderRef = (
    ref: string | null
  ): { sandboxId: string; containment: boolean } | null => {
    if (ref === deps.sandboxId) return { sandboxId: deps.sandboxId, containment: false };
    const parsed = decodeCloudflareProviderRef(ref);
    return parsed?.sandboxId === deps.sandboxId ? parsed : null;
  };
  const resolveProviderRef = (
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): string | null => {
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
    if (!parsed) throw new ProviderCreationError('invalid_configuration');
    let input: ReturnType<typeof parseSandboxBillingInput>;
    try {
      input = parseSandboxBillingInput({ ...billing, sandboxId: parsed.sandboxId });
    } catch {
      throw new ProviderCreationError('invalid_configuration');
    }
    const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
    const blocked = await isSandboxBillingBlocked(sandbox, input.enforcementRequested);
    if (input.enforcementRequested || blocked) {
      const admission = await ensureSandboxBillingAdmissionInput(sandbox, input);
      if (!admission.success) {
        throw new ProviderCreationError(admission.code);
      }
    } else {
      await configureSandboxBillingInput(sandbox, input).catch(() => undefined);
    }
  };

  return {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    ensureBillingAdmission,
    async probeWrapperProcesses(ref) {
      const parsed = decodeOwnedProviderRef(ref);
      if (!parsed) return { outcome: 'invalid_reference' };
      let timedOut = false;
      const execPromise = (async () => {
        const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
        return sandbox.exec(WRAPPER_PROC_SCAN_COMMAND);
      })();
      execPromise.catch(() => undefined);
      let result: ExecResult;
      try {
        result = await withTimeout(
          execPromise,
          WRAPPER_PROC_PROBE_TIMEOUT_MS,
          'Wrapper process probe timed out',
          () => {
            timedOut = true;
          }
        );
      } catch {
        return { outcome: timedOut ? 'timeout' : 'error' };
      }
      const scan = parseWrapperProcScanOutput(result.stdout ?? '');
      return scan.kind === 'count'
        ? { outcome: 'count', count: scan.count, incomplete: scan.incomplete }
        : { outcome: 'unparsed' };
    },
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
        throw new ProviderCreationError('invalid_configuration');
      }
      const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
      if (parsed.containment) await sandbox.setOutboundHandler(MANAGED_SCM_OUTBOUND_HANDLER);
      await sandbox.startProcess(CONTROL_SUPERVISOR_PATH, {
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
      const diagnostic = {
        provider: 'cloudflare',
        allocationName: deps.sandboxId,
        intentId: intent?.intentId,
      };
      if (!parsed) {
        logControlDiagnostic('native_stop', { ...diagnostic, result: 'invalid_reference' });
        return 'retryable';
      }
      const startedAt = Date.now();
      logControlDiagnostic('native_stop', { ...diagnostic, result: 'started' });
      try {
        await deps.destroy(parsed.sandboxId, { containment: parsed.containment });
        logControlDiagnostic('native_stop', {
          ...diagnostic,
          result: 'terminal',
          durationMs: Date.now() - startedAt,
        });
        return 'terminal';
      } catch {
        logControlDiagnostic(
          'native_stop',
          {
            ...diagnostic,
            result: 'retryable',
            durationMs: Date.now() - startedAt,
          },
          'warn'
        );
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const parsed = decodeOwnedProviderRef(ref);
      logControlDiagnostic('native_lease', {
        provider: 'cloudflare',
        allocationName: deps.sandboxId,
        requestedLeaseMs: ms,
        action: parsed === null ? 'invalid_reference' : 'activity_timeout_renewal',
      });
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
