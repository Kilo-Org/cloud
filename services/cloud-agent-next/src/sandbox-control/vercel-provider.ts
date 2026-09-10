import { withTimeout } from '@kilocode/worker-utils';
import { z } from 'zod';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import {
  VercelSandboxRestClient,
  VercelSandboxRestError,
  type ExecuteCommandInput,
  type VercelSandboxCommand,
  type VercelSandboxSession,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import { DEADLINE_MS } from './deadlines.js';
import { logControlDiagnostic } from './diagnostics.js';
import type { ObserveResult } from './physical-lifecycle.js';
import type { ProviderAdapter, ProviderCreateIntent } from './provider.js';

const CONTROL_WRAPPER_PATH = '/usr/local/bin/kilocode-control-wrapper.js';
const CONTROL_WRAPPER_LOG_PATH = '/tmp/kilocode-control-wrapper.log';
const LOG_MAX_BYTES = 1024 * 1024;

const ACTIVE_STATUSES = new Set<VercelSandboxSession['status']>([
  'pending',
  'running',
  'snapshotting',
  'stopping',
]);
const TERMINAL_STATUSES = new Set<VercelSandboxSession['status']>(['stopped', 'failed', 'aborted']);

const providerRefSchema = z
  .object({
    sandboxName: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict();

export type VercelProviderRef = z.infer<typeof providerRefSchema>;

export const vercelProviderLocatorSchema = z
  .object({
    teamId: z.string().min(1),
    projectId: z.string().min(1),
    snapshotId: z.string().min(1),
    runtimeBuildId: z.string().min(1),
    runtime: z.literal('node24'),
  })
  .strict();
export type VercelProviderLocator = z.infer<typeof vercelProviderLocatorSchema>;

export type VercelControlRestClient = {
  createSandbox: VercelSandboxRestClient['createSandbox'];
  inspectByName: VercelSandboxRestClient['inspectByName'];
  getSession: VercelSandboxRestClient['getSession'];
  executeCommand: (
    sessionId: string,
    input: ExecuteCommandInput & { wait: false }
  ) => Promise<VercelSandboxCommand>;
  extendSessionTimeout: VercelSandboxRestClient['extendSessionTimeout'];
  stopSession: VercelSandboxRestClient['stopSession'];
  readFile: VercelSandboxRestClient['readFile'];
  updateNetworkPolicy: VercelSandboxRestClient['updateNetworkPolicy'];
};

export function encodeVercelProviderRef(ref: VercelProviderRef): string {
  return JSON.stringify(ref);
}

export function decodeVercelProviderRef(raw: string | null): VercelProviderRef | null {
  if (raw === null) return null;
  try {
    const parsed = providerRefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function observeStatus(status: VercelSandboxSession['status']): ObserveResult {
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (TERMINAL_STATUSES.has(status)) return 'terminal';
  return 'unknown';
}

function isNotFound(error: unknown): boolean {
  return error instanceof VercelSandboxRestError && error.status === 404;
}

export function createVercelProviderAdapter(deps: {
  sandboxName: string;
  config?: VercelSandboxRuntimeConfig;
  restClient?: VercelControlRestClient;
  now?: () => number;
}): ProviderAdapter {
  const config = deps.config;
  if (!config) {
    const unavailable = async (): Promise<never> => {
      throw new Error('Vercel sandbox runtime configuration is unavailable');
    };
    return {
      resumable: false,
      ensureBillingAdmission: unavailable,
      create: unavailable,
      launch: unavailable,
      observe: async () => ({ status: 'unknown' }),
      stop: async () => 'retryable',
      ensureLeaseAtLeast: unavailable,
      logs: async () => 'Vercel sandbox runtime configuration is unavailable',
      updateNetworkPolicy: unavailable,
    };
  }
  const restClient =
    deps.restClient ??
    new VercelSandboxRestClient({
      accessToken: config.accessToken,
      teamId: config.teamId,
      projectId: config.projectId,
      fetch,
    });
  const now = deps.now ?? Date.now;
  const decodeOwnedProviderRef = (ref: string | null): VercelProviderRef | null => {
    const parsed = decodeVercelProviderRef(ref);
    return parsed?.sandboxName === deps.sandboxName ? parsed : null;
  };
  const ensureBillingAdmission: ProviderAdapter['ensureBillingAdmission'] = async (
    _ref,
    billing
  ) => {
    if (billing?.enforcementRequested) {
      throw new AgentSandboxUnavailableError(
        'Container billing admission is unavailable for Vercel sandbox sessions',
        'billing_blocked'
      );
    }
  };

  return {
    resumable: false,
    ensureBillingAdmission,
    async create(intent: ProviderCreateIntent) {
      await ensureBillingAdmission(intent.allocationName ?? deps.sandboxName, intent.billing);
      const created = await restClient.createSandbox({
        name: intent.allocationName ?? deps.sandboxName,
        operationId: intent.intentId,
        runtimeBuildId: config.runtimeBuildId,
        snapshotId: config.snapshotId,
        runtime: config.runtime,
        timeoutMs: config.initialTimeoutMs,
        ...(config.resources === undefined ? {} : { resources: config.resources }),
        ...(intent.networkPolicy === undefined ? {} : { networkPolicy: intent.networkPolicy }),
      });
      return { providerRef: encodeVercelProviderRef(created.runtime) };
    },
    async launch(ref, env) {
      const parsed = decodeOwnedProviderRef(ref);
      if (!parsed) throw new Error('Invalid Vercel sandbox allocation');
      await restClient.executeCommand(parsed.sessionId, {
        command: 'sh',
        args: ['-lc', `exec bun run ${CONTROL_WRAPPER_PATH}`],
        cwd: '/',
        env: {
          ...env,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        },
        sudo: false,
        wait: false,
      });
    },
    async observe(ref, intent) {
      const parsed = decodeOwnedProviderRef(ref);
      try {
        if (parsed) {
          const { session } = await restClient.getSession(parsed.sessionId, parsed.sandboxName);
          return { status: observeStatus(session.status) };
        }
        if (ref !== null || !intent) return { status: 'unknown' };
        const inspected = await restClient.inspectByName({
          name: intent.allocationName ?? deps.sandboxName,
          operationId: intent.intentId,
          runtimeBuildId: config.runtimeBuildId,
          snapshotId: config.snapshotId,
          runtime: config.runtime,
          ...(config.resources === undefined ? {} : { resources: config.resources }),
        });
        if (!inspected) {
          return {
            status: now() < intent.createdAt + DEADLINE_MS.createSettle ? 'unknown' : 'terminal',
          };
        }
        return {
          status: observeStatus(inspected.session.status),
          providerRef: encodeVercelProviderRef(inspected.runtime),
        };
      } catch (error) {
        return { status: parsed && isNotFound(error) ? 'terminal' : 'unknown' };
      }
    },
    async stop(ref) {
      const parsed = decodeOwnedProviderRef(ref);
      const diagnostic = {
        provider: 'vercel',
        allocationName: deps.sandboxName,
        providerSessionId: parsed?.sessionId,
      };
      if (parsed === null) {
        logControlDiagnostic('native_stop', { ...diagnostic, result: 'invalid_reference' });
        return 'retryable';
      }
      const startedAt = now();
      logControlDiagnostic('native_stop', { ...diagnostic, result: 'started' });
      try {
        const session = await restClient.stopSession(parsed.sessionId, parsed.sandboxName);
        const result = TERMINAL_STATUSES.has(session.status) ? 'terminal' : 'retryable';
        logControlDiagnostic('native_stop', {
          ...diagnostic,
          result,
          durationMs: now() - startedAt,
        });
        return result;
      } catch (error) {
        const result = isNotFound(error) ? 'terminal' : 'retryable';
        logControlDiagnostic('native_stop', {
          ...diagnostic,
          result,
          durationMs: now() - startedAt,
        });
        return result;
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const parsed = decodeOwnedProviderRef(ref);
      const diagnostic = {
        provider: 'vercel',
        allocationName: deps.sandboxName,
        providerSessionId: parsed?.sessionId,
        requestedLeaseMs: ms,
      };
      if (parsed === null) {
        logControlDiagnostic('native_lease', { ...diagnostic, action: 'invalid_reference' });
        return;
      }
      const { session } = await restClient.getSession(parsed.sessionId, parsed.sandboxName);
      if (session.status !== 'running') {
        logControlDiagnostic('native_lease', { ...diagnostic, action: 'not_running' });
        return;
      }
      const startedAt = session.startedAt ?? session.requestedAt;
      const remaining = startedAt + session.timeout - now();
      logControlDiagnostic('native_lease', {
        ...diagnostic,
        remainingMs: remaining,
        action: remaining > ms ? 'sufficient_remaining' : 'extension',
        extensionMs: remaining > ms ? undefined : Math.max(ms, config.extendDurationMs),
      });
      if (remaining > ms) return;
      await restClient.extendSessionTimeout(
        parsed.sessionId,
        parsed.sandboxName,
        Math.max(ms, config.extendDurationMs)
      );
    },
    async logs(ref) {
      const parsed = decodeOwnedProviderRef(ref);
      if (parsed === null) return `vercel ${ref}`;
      try {
        const bytes = await withTimeout(
          restClient.readFile(parsed.sessionId, CONTROL_WRAPPER_LOG_PATH, LOG_MAX_BYTES),
          DEADLINE_MS.stopAttempt,
          'Vercel sandbox logs timed out'
        );
        return new TextDecoder().decode(bytes);
      } catch {
        return `vercel ${parsed.sessionId} logs unavailable`;
      }
    },
    async updateNetworkPolicy(providerRef, networkPolicy) {
      const parsed = decodeOwnedProviderRef(providerRef);
      if (parsed === null) throw new Error('Invalid Vercel sandbox provider reference');
      const session = await restClient.updateNetworkPolicy(
        parsed.sessionId,
        parsed.sandboxName,
        networkPolicy
      );
      if (session.id !== parsed.sessionId || session.sourceSandboxName !== parsed.sandboxName) {
        throw new Error('Vercel sandbox policy update returned a different session');
      }
      if (session.status !== 'running') throw new Error('Vercel sandbox session is not running');
    },
  };
}
