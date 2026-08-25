import { z } from 'zod';
import { logger } from '../logger.js';
import {
  VercelSandboxRestClient,
  VercelSandboxRestError,
  type ExecuteCommandInput,
  type VercelSandboxCommand,
  type VercelSandboxSession,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
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

export type VercelControlRestClient = {
  createSandbox: VercelSandboxRestClient['createSandbox'];
  getSession: VercelSandboxRestClient['getSession'];
  executeCommand: (
    sessionId: string,
    input: ExecuteCommandInput & { wait: false }
  ) => Promise<VercelSandboxCommand>;
  extendSessionTimeout: VercelSandboxRestClient['extendSessionTimeout'];
  stopSession: VercelSandboxRestClient['stopSession'];
  readFile: VercelSandboxRestClient['readFile'];
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
  config: VercelSandboxRuntimeConfig;
  restClient?: VercelControlRestClient;
  now?: () => number;
}): ProviderAdapter {
  const restClient =
    deps.restClient ??
    new VercelSandboxRestClient({
      accessToken: deps.config.accessToken,
      teamId: deps.config.teamId,
      projectId: deps.config.projectId,
      fetch,
    });
  const now = deps.now ?? Date.now;

  return {
    resumable: false,
    async create(intent: ProviderCreateIntent) {
      const created = await restClient.createSandbox({
        name: deps.sandboxName,
        operationId: intent.intentId,
        runtimeBuildId: deps.config.runtimeBuildId,
        snapshotId: deps.config.snapshotId,
        runtime: deps.config.runtime,
        timeoutMs: deps.config.initialTimeoutMs,
      });
      const providerRef = encodeVercelProviderRef({
        sandboxName: created.runtime.sandboxName,
        sessionId: created.runtime.sessionId,
      });
      try {
        await restClient.executeCommand(created.runtime.sessionId, {
          command: 'sh',
          args: ['-lc', `exec bun run ${CONTROL_WRAPPER_PATH}`],
          cwd: '/',
          env: {
            ...intent.env,
            WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
          },
          sudo: false,
          wait: false,
        });
      } catch (error) {
        logger
          .withFields({
            sandboxId: deps.sandboxName,
            sessionId: created.runtime.sessionId,
            error: error instanceof Error ? error.message : 'control wrapper start failed',
          })
          .warn('Vercel control wrapper failed to start; VM kept for stop');
      }
      return { providerRef };
    },
    async observe(ref) {
      const parsed = decodeVercelProviderRef(ref);
      if (parsed === null) return ref === null ? 'terminal' : 'unknown';
      try {
        const { session } = await restClient.getSession(parsed.sessionId, parsed.sandboxName);
        return observeStatus(session.status);
      } catch (error) {
        if (isNotFound(error)) return 'terminal';
        return 'unknown';
      }
    },
    async stop(ref) {
      const parsed = decodeVercelProviderRef(ref);
      if (parsed === null) return 'terminal';
      try {
        const session = await restClient.stopSession(parsed.sessionId, parsed.sandboxName);
        return TERMINAL_STATUSES.has(session.status) ? 'terminal' : 'retryable';
      } catch (error) {
        if (isNotFound(error)) return 'terminal';
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const parsed = decodeVercelProviderRef(ref);
      if (parsed === null) return;
      const { session } = await restClient.getSession(parsed.sessionId, parsed.sandboxName);
      if (session.status !== 'running') return;
      const startedAt = session.startedAt ?? session.requestedAt;
      const remaining = startedAt + session.timeout - now();
      if (remaining > ms) return;
      await restClient.extendSessionTimeout(
        parsed.sessionId,
        parsed.sandboxName,
        Math.max(ms, deps.config.extendDurationMs)
      );
    },
    async logs(ref) {
      const parsed = decodeVercelProviderRef(ref);
      if (parsed === null) return `vercel ${ref ?? 'none'}`;
      try {
        const bytes = await restClient.readFile(
          parsed.sessionId,
          CONTROL_WRAPPER_LOG_PATH,
          LOG_MAX_BYTES
        );
        return new TextDecoder().decode(bytes);
      } catch {
        return `vercel ${parsed.sessionId} logs unavailable`;
      }
    },
  };
}
