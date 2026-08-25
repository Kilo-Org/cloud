import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../shared/control-plane-permission.js';
import { sandboxControlWebSocketUrl } from './control-url.js';

export type ControlWrapperLaunchEnvInput = {
  workerUrl?: string;
  sandboxId: string;
  credential: string;
  kiloToken?: string;
  kiloTargetEnv: KiloTargetEnv;
};

export function buildControlWrapperLaunchEnv(
  input: ControlWrapperLaunchEnvInput
): Record<string, string> {
  const workerUrl = input.workerUrl?.replace(/\/$/, '') ?? '';
  const env: Record<string, string> = {
    SANDBOX_CONTROL_URL: sandboxControlWebSocketUrl(workerUrl, input.sandboxId),
    SANDBOX_CONTROL_CREDENTIAL: input.credential,
    PROVIDER_INSTANCE_ID: input.sandboxId,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  };
  if (!input.kiloToken) return env;

  env.KILOCODE_TOKEN = input.kiloToken;
  env.KILO_AUTH_CONTENT = JSON.stringify({ kilo: { type: 'api', key: input.kiloToken } });
  const targets = deriveKiloSandboxTargets(input.kiloTargetEnv, input.kiloToken);
  if (!targets.success) return env;

  env.KILOCODE_BACKEND_BASE_URL = targets.targets.backendBaseUrl;
  env.KILO_API_URL = targets.targets.backendBaseUrl;
  env.KILO_OPENROUTER_BASE = targets.targets.providerBaseUrl;
  env.KILO_SESSION_INGEST_URL = targets.targets.sessionIngestBaseUrl;
  const configJson = JSON.stringify({
    autoupdate: false,
    permission: CONTROL_PLANE_SANDBOX_PERMISSION,
    provider: {
      kilo: {
        options: {
          apiKey: input.kiloToken,
          kilocodeToken: input.kiloToken,
          baseURL: targets.targets.providerBaseUrl,
        },
      },
    },
  });
  env.KILO_CONFIG_CONTENT = configJson;
  env.OPENCODE_CONFIG_CONTENT = configJson;
  return env;
}
