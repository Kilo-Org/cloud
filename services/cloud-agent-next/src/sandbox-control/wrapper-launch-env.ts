import { sandboxControlWebSocketUrl } from './control-url.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';
import { normalizeWorkerOrigin } from './worker-origin.js';

export type ControlWrapperLaunchEnvInput = {
  workerUrl?: string;
  sandboxId: string;
  credential: string;
  workloadCgroup?: string;
  diagnostics?: {
    allocationId: string;
    signingSecret: string | null;
  };
};

export function buildControlWrapperLaunchEnv(
  input: ControlWrapperLaunchEnvInput
): Record<string, string> {
  const workerUrl = input.workerUrl?.replace(/\/$/, '') ?? '';
  let diagnosticEnv: Record<string, string> = {};
  const diagnosticOrigin = normalizeWorkerOrigin(input.workerUrl);
  if (input.diagnostics?.signingSecret && diagnosticOrigin) {
    try {
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
        CONTROL_LOG_UPLOAD_URL: `${diagnosticOrigin}/sandbox-logs/${path}`,
        CONTROL_LOG_UPLOAD_GRANT: grant,
        CONTROL_WRAPPER_INSTANCE_ID: identity.wrapperInstanceId,
      };
    } catch {
      diagnosticEnv = {};
    }
  }
  return {
    ...diagnosticEnv,
    ...(input.workloadCgroup ? { CONTROL_WORKLOAD_CGROUP: input.workloadCgroup } : {}),
    SANDBOX_CONTROL_URL: sandboxControlWebSocketUrl(workerUrl, input.sandboxId),
    SANDBOX_CONTROL_CREDENTIAL: input.credential,
    PROVIDER_INSTANCE_ID: input.sandboxId,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  };
}
