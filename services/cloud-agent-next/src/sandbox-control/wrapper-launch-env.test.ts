import { describe, expect, it } from 'vitest';
import { deriveKiloSandboxTargets } from '../kilo/kilo-targets.js';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';

describe('buildControlWrapperLaunchEnv', () => {
  it('passes derived ingest and backend URLs to the sandbox', () => {
    const kiloTargetEnv = {
      KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com',
      KILO_OPENROUTER_BASE: 'https://openrouter.example.com/api',
      KILO_SESSION_INGEST_URL: 'https://ingest.example.com',
    };
    const derived = deriveKiloSandboxTargets(kiloTargetEnv, 'user-token');
    if (!derived.success) throw new Error('expected valid targets');

    const env = buildControlWrapperLaunchEnv({
      workerUrl: 'https://worker.example.com',
      sandboxId: 'sbx_1',
      credential: 'cred',
      kiloToken: 'user-token',
      kiloTargetEnv,
    });

    expect(env.KILO_SESSION_INGEST_URL).toBe(derived.targets.sessionIngestBaseUrl);
    expect(env.KILO_API_URL).toBe(derived.targets.backendBaseUrl);
    expect(env.KILOCODE_BACKEND_BASE_URL).toBe(derived.targets.backendBaseUrl);
    expect(env.KILO_OPENROUTER_BASE).toBe(derived.targets.providerBaseUrl);
    expect(env.SANDBOX_CONTROL_URL).toBe('wss://worker.example.com/sandbox-control/sbx_1');
    const config = JSON.parse(env.KILO_CONFIG_CONTENT) as {
      permission: { bash: string; doom_loop: string };
    };
    expect(config.permission.bash).toBe('allow');
    expect(config.permission.doom_loop).toBe('allow');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(env.KILO_CONFIG_CONTENT);
  });

  it('omits kilo targets when no token is provided', () => {
    const env = buildControlWrapperLaunchEnv({
      workerUrl: 'https://worker.example.com',
      sandboxId: 'sbx_1',
      credential: 'cred',
      kiloTargetEnv: { KILO_SESSION_INGEST_URL: 'https://ingest.example.com' },
    });
    expect(env.KILO_SESSION_INGEST_URL).toBeUndefined();
    expect(env.KILOCODE_TOKEN).toBeUndefined();
  });
});
