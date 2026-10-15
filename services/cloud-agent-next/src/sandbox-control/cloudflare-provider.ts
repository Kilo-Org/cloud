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
import { withDORetry } from '../utils/do-retry.js';
import {
  RUNTIME_ARTIFACT_GRANT_SECONDS,
  mintRuntimeArtifactGrant,
} from './runtime-artifact-grant.js';
import {
  type RuntimeArtifactReader,
  RuntimeInstallerError,
  loadRuntimeRelease,
  runtimeInstallerReasonForCode,
} from './runtime-release-loader.js';
import {
  RUNTIME_ARTIFACT_GRANT_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_DESCRIPTOR_ENV,
  runtimeLaunchCommand,
} from './runtime-bootstrap.js';
import { observeRuntimeLaunchPhase } from './runtime-launch-phase.js';
import { runtimeLaunchReceiptPath } from './runtime-launch-receipt.js';
import {
  RUNTIME_DEFAULT_DEADLINE_MS,
  parseTrustedRuntimeArtifactOrigin,
  runtimeArtifactHashes,
} from '../shared/runtime-release.js';

export const WRAPPER_PROC_PROBE_TIMEOUT_MS = 5_000;

/**
 * Trusted cold-launch inputs (amendment "cold session without a snapshot"). They
 * are derived from the Worker environment at DO construction and passed into the
 * adapter; no launch reads a descriptor from a request, an R2 object, or a
 * sandbox file. An absent descriptor is the explicit baked selection.
 */
export type CloudflareRuntimeReleaseDeps = {
  /** Private object store the preflight verifies the two artifacts against. */
  reader: RuntimeArtifactReader;
  /** Trusted generated-config descriptor; `undefined` is the baked image. */
  descriptor: string | undefined;
  /** Resolve the artifact read-grant signing secret at launch. */
  grantSecret: () => Promise<string | null>;
  /** Trusted absolute artifact origin; `undefined` fails a descriptor launch. */
  origin: string | undefined;
};

/** Small bound for the best-effort launch-receipt cleanup; it never blocks a handoff. */
const RUNTIME_LAUNCH_RECEIPT_CLEANUP_MS = 5_000;

/**
 * Start the verified cold runtime. Preflight checks that both objects are
 * published with their declared size before the read grant is minted; the
 * installer hashes the downloaded bytes. A present but unverifiable descriptor
 * throws with no baked fallback. `allocationId` is the
 * decoded allocation identity (`providerRef.instanceId`), the one grant owner.
 */
async function startRuntimeRelease(
  release: CloudflareRuntimeReleaseDeps,
  sandbox: CloudflareSandboxHandle,
  env: Record<string, string>,
  allocationId: string,
  deadlineAtOption: number | undefined
): Promise<void> {
  const descriptor = release.descriptor;
  if (descriptor === undefined) {
    throw new RuntimeInstallerError(
      'runtime_artifact_missing',
      'runtime release descriptor is absent'
    );
  }
  const deadlineAt = deadlineAtOption ?? Date.now() + RUNTIME_DEFAULT_DEADLINE_MS;
  const loaded = await loadRuntimeRelease({ reader: release.reader, descriptor, deadlineAt });
  if (loaded === null) {
    throw new RuntimeInstallerError('runtime_artifact_missing', 'runtime release was not verified');
  }
  const secret = await release.grantSecret();
  if (!secret) {
    throw new RuntimeInstallerError(
      'runtime_artifact_unavailable',
      'runtime artifact grant signing is unavailable'
    );
  }
  const origin = parseTrustedRuntimeArtifactOrigin(release.origin);
  if (origin === null) {
    throw new RuntimeInstallerError(
      'runtime_artifact_unavailable',
      'runtime artifact origin must be a trusted HTTPS origin'
    );
  }
  const ttlSeconds = Math.min(
    RUNTIME_ARTIFACT_GRANT_SECONDS,
    Math.max(1, Math.floor((deadlineAt - Date.now()) / 1000))
  );
  const grant = mintRuntimeArtifactGrant(
    { hashes: runtimeArtifactHashes(loaded), allocationId },
    secret,
    ttlSeconds
  );
  const launchId = crypto.randomUUID();
  const command = runtimeLaunchCommand({ launchId, deadlineAt });
  const process = await sandbox.startProcess(command, {
    cwd: '/',
    // The terminal record must outlive exit so the launch phase can read a fresh
    // DTO; the sandbox destroy releases it. The launch never uses waitForExit,
    // whose SSE stream would otherwise stay open for a healthy supervisor.
    autoCleanup: false,
    env: {
      ...env,
      [RUNTIME_DESCRIPTOR_ENV]: descriptor,
      [RUNTIME_ARTIFACT_GRANT_ENV]: grant,
      [RUNTIME_ARTIFACT_ORIGIN_ENV]: origin,
    },
  });
  const outcome = await observeRuntimeLaunchPhase(
    sandbox,
    sandbox,
    process.id,
    launchId,
    deadlineAt
  );
  // Best-effort cleanup of only this launch's own receipt, at its fixed path and
  // safe id. It is fire-and-forget and bounded, so a handoff never waits on it;
  // the SDK's HTTP request is finite, and a missed delete is at worst a bounded
  // stored receipt. Never another launch's file or a user file.
  void withTimeout(
    sandbox.deleteFile(runtimeLaunchReceiptPath(launchId)),
    RUNTIME_LAUNCH_RECEIPT_CLEANUP_MS,
    'runtime launch receipt cleanup timed out'
  ).catch(() => undefined);
  if (outcome.kind === 'handoff') return;
  if (outcome.kind === 'installer-failed') {
    throw new RuntimeInstallerError(
      runtimeInstallerReasonForCode(outcome.code),
      `runtime installer failed (code ${outcome.code})`
    );
  }
  if (outcome.kind === 'deadline') {
    throw new RuntimeInstallerError(
      'runtime_artifact_deadline',
      'runtime release deadline exceeded before the supervisor handed off'
    );
  }
  throw new Error('runtime bootstrap failed without a phase receipt');
}

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
  /**
   * Trusted cold-launch inputs. Absent, and a descriptor absent within it, keep
   * the baked supervisor selection.
   */
  runtimeRelease?: CloudflareRuntimeReleaseDeps;
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
      await withDORetry(
        () => deps.getSandbox(parsed.sandboxId, { containment: parsed.containment }),
        sandbox => configureSandboxBillingInput(sandbox, input),
        'configureSandboxBilling'
      );
    }
  };

  return {
    ensureBillingAdmission,
    describeRuntime(ref) {
      const parsed = decodeCloudflareProviderRef(ref);
      if (parsed?.sandboxId !== deps.sandboxId) return undefined;
      return {
        provider: 'cloudflare',
        sandboxId: parsed.sandboxId,
        instanceId: parsed.instanceId,
        startSource: 'image',
      };
    },
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
    async launch(ref, env, options) {
      const parsed = decodeCloudflareProviderRef(ref);
      if (!parsed || parsed.sandboxId !== deps.sandboxId) {
        throw new ProviderCreationError('invalid_configuration');
      }
      const sandbox = deps.getSandbox(parsed.sandboxId, { containment: parsed.containment });
      if (parsed.containment) await sandbox.setOutboundHandler(MANAGED_SCM_OUTBOUND_HANDLER);
      const launchEnv = {
        ...env,
        PROVIDER_INSTANCE_ID: ref,
        WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
      };
      // One launch selection (amendment "cold session without a snapshot"): a
      // trusted descriptor starts the verified runtime-launch command; no
      // descriptor starts the baked supervisor path unchanged.
      if (deps.runtimeRelease && deps.runtimeRelease.descriptor !== undefined) {
        // The grant identity is the decoded allocation id, not the encoded
        // provider ref (which is a >128-byte JSON the grant schema rejects).
        await startRuntimeRelease(
          deps.runtimeRelease,
          sandbox,
          launchEnv,
          parsed.instanceId,
          options?.deadlineAt
        );
      } else {
        await sandbox.startProcess(CONTROL_SUPERVISOR_PATH, { cwd: '/', env: launchEnv });
      }
      return { startSource: 'image' };
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
