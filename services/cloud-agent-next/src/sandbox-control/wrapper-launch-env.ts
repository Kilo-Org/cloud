import { sandboxControlWebSocketUrl } from './control-url.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';
import {
  CONTROL_SANDBOX_PROVIDER_ENV,
  type AgentSandboxProvider,
} from '../shared/sandbox-provider.js';
import { WORKTREE_SNAPSHOT_ROUTE_PREFIX } from '../shared/worktree-snapshot.js';

export type ControlWrapperLaunchEnvInput = {
  workerUrl?: string;
  sandboxId: string;
  provider: AgentSandboxProvider;
  credential: string;
  workloadCgroup?: string;
  diagnostics?: {
    allocationId: string;
    signingSecret: string | null;
  };
  worktreeSnapshotWrites?: boolean;
};

function validWorkerUrl(workerUrl: string | undefined): string | undefined {
  if (!workerUrl) return undefined;
  try {
    const base = new URL(workerUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return undefined;
    }
    return workerUrl;
  } catch {
    return undefined;
  }
}

export function buildControlWrapperLaunchEnv(
  input: ControlWrapperLaunchEnvInput
): Record<string, string> {
  const workerUrl = input.workerUrl?.replace(/\/$/, '') ?? '';
  const snapshotBaseUrl = input.worktreeSnapshotWrites ? validWorkerUrl(workerUrl) : undefined;
  let diagnosticEnv: Record<string, string> = {};
  if (input.diagnostics?.signingSecret && workerUrl) {
    try {
      if (validWorkerUrl(workerUrl) === undefined)
        throw new Error('Invalid diagnostic upload origin');
      const identity = {
        sandboxId: input.sandboxId,
        allocationId: input.diagnostics.allocationId,
        wrapperInstanceId: crypto.randomUUID(),
      };
      const grant = mintControlLogUploadGrant(identity, input.diagnostics.signingSecret);
      const path = [identity.sandboxId, identity.allocationId, identity.wrapperInstanceId]
        .map(encodeURIComponent)
        .join('/');
      diagnosticEnv = {
        CONTROL_LOG_UPLOAD_URL: `${workerUrl}/sandbox-logs/${path}`,
        CONTROL_LOG_UPLOAD_GRANT: grant,
        CONTROL_WRAPPER_INSTANCE_ID: identity.wrapperInstanceId,
      };
    } catch {
      diagnosticEnv = {};
    }
  }
  return {
    ...diagnosticEnv,
    ...(snapshotBaseUrl === undefined
      ? {}
      : {
          CONTROL_WORKTREE_SNAPSHOT_URL: `${snapshotBaseUrl}${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/${encodeURIComponent(input.sandboxId)}`,
        }),
    // The Vercel node24 snapshot installs Bun and global CLIs in /usr/local/bin.
    // Supply the runtime path directly instead of reading a snapshot's login profile.
    ...(input.provider === 'vercel'
      ? {
          PATH: '/usr/local/bin:/vercel/runtimes/node24/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
        }
      : {}),
    ...(input.workloadCgroup ? { CONTROL_WORKLOAD_CGROUP: input.workloadCgroup } : {}),
    SANDBOX_CONTROL_URL: sandboxControlWebSocketUrl(workerUrl, input.sandboxId),
    SANDBOX_CONTROL_CREDENTIAL: input.credential,
    PROVIDER_INSTANCE_ID: input.sandboxId,
    [CONTROL_SANDBOX_PROVIDER_ENV]: input.provider,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  };
}
