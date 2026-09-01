import { sandboxControlWebSocketUrl } from './control-url.js';

export type ControlWrapperLaunchEnvInput = {
  workerUrl?: string;
  sandboxId: string;
  credential: string;
};

export function buildControlWrapperLaunchEnv(
  input: ControlWrapperLaunchEnvInput
): Record<string, string> {
  const workerUrl = input.workerUrl?.replace(/\/$/, '') ?? '';
  return {
    SANDBOX_CONTROL_URL: sandboxControlWebSocketUrl(workerUrl, input.sandboxId),
    SANDBOX_CONTROL_CREDENTIAL: input.credential,
    PROVIDER_INSTANCE_ID: input.sandboxId,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  };
}
