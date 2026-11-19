import { sandboxControlWebSocketUrl } from './control-url.js';
import { getSentryConfig } from '../shared/sentry.js';
import { mintControlLogUploadGrant, mintSandboxTransferGrant } from './sandbox-transfer-grant.js';
import { sandboxTransferScopes } from '../shared/control-diagnostics.js';
import {
  CONTROL_SANDBOX_PROVIDER_ENV,
  PROVIDER_DESCRIPTORS,
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
  let transferEnv: Record<string, string> = {};
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
        throw new Error('Invalid transfer upload origin');
      }
      const identity = {
        sandboxId: input.sandboxId,
        allocationId: input.diagnostics.allocationId,
        wrapperInstanceId: crypto.randomUUID(),
      };
      const transfer = mintSandboxTransferGrant(
        identity,
        sandboxTransferScopes,
        input.diagnostics.signingSecret
      );
      const legacyGrant = mintControlLogUploadGrant(identity, input.diagnostics.signingSecret);
      const path = [identity.sandboxId, identity.allocationId, identity.wrapperInstanceId]
        .map(encodeURIComponent)
        .join('/');
      transferEnv = {
        SANDBOX_TRANSFER_URL: `${workerUrl}/sandbox-transfer/${path}`,
        SANDBOX_TRANSFER_GRANT: transfer.grant,
        CONTROL_LOG_UPLOAD_URL: `${workerUrl}/sandbox-logs/${path}`,
        CONTROL_LOG_UPLOAD_GRANT: legacyGrant,
        CONTROL_WRAPPER_INSTANCE_ID: identity.wrapperInstanceId,
      };
    } catch {
      transferEnv = {};
    }
  }
  return {
    ...transferEnv,
    // Provider launch facts, such as the Vercel runtime PATH.
    ...PROVIDER_DESCRIPTORS[input.provider].launchEnv,
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
