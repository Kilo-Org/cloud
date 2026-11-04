import { sandboxControlWebSocketUrl } from './control-url.js';
import { getSentryConfig } from '../shared/sentry.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';
import {
  CONTROL_SANDBOX_PROVIDER_ENV,
  type AgentSandboxProvider,
} from '../shared/sandbox-provider.js';

export type ControlWrapperLaunchEnvInput = {
  workerUrl?: string;
  sandboxId: string;
  provider: AgentSandboxProvider;
  credential: string;
  workloadCgroup?: string;
  sentry?: Parameters<typeof getSentryConfig>[0];
  diagnostics?: {
    allocationId: string;
    signingSecret: string | null;
  };
};

export function buildControlWrapperLaunchEnv(
  input: ControlWrapperLaunchEnvInput
): Record<string, string> {
  const workerUrl = input.workerUrl?.replace(/\/$/, '') ?? '';
  const sentry = getSentryConfig(input.sentry ?? {});
  let diagnosticEnv: Record<string, string> = {};
  if (input.diagnostics?.signingSecret && workerUrl) {
    try {
      const base = new URL(workerUrl);
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      ) {
        throw new Error('Invalid diagnostic upload origin');
      }
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
    // The Vercel node24 snapshot installs Bun and global CLIs in /usr/local/bin.
    // Supply the runtime path directly instead of reading a snapshot's login profile.
    ...(input.provider === 'vercel'
      ? {
          PATH: '/usr/local/bin:/vercel/runtimes/node24/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
        }
      : {}),
    ...(sentry
      ? {
          CLOUD_AGENT_SENTRY_DSN: sentry.dsn,
          CLOUD_AGENT_SENTRY_ENVIRONMENT: sentry.environment,
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
