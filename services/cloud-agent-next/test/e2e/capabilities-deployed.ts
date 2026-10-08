/**
 * The deployed profile's capability factory. It deliberately provides no local
 * `sandbox` capability: the deployed driver has no local Docker daemon, so
 * container identity is observed through the e2e Worker surface instead.
 *
 * When no `surfaceUrl` or no e2e internal secret is configured, the
 * `sessionSandbox` and `callbacks` capabilities are absent, so every scenario
 * that declares them is `unsupported` — never a silent unauthenticated run.
 */

import type { AgentSandboxProvider } from '../../src/types.js';
import { createHttpCallbacks, createHttpSessionSandbox } from './e2e-surface-client.js';
import type { ScenarioEnvironment } from './scenario-capabilities.js';

export type DeployedScenarioEnvironmentInput = {
  surfaceUrl?: string;
  bearerToken?: string;
  internalApiSecret?: string;
  /** Required provider when a run selects an explicit allocation. */
  expectedProvider?: AgentSandboxProvider;
};

export function createDeployedScenarioEnvironment(
  input: DeployedScenarioEnvironmentInput = {}
): ScenarioEnvironment {
  const env: ScenarioEnvironment = {
    profile: 'deployed',
    requireControlPlaneSession: true,
    deployedHttpAuthBoundary: { modelRoutesAuthenticated: true },
  };

  const surfaceUrl = input.surfaceUrl?.trim();
  const internalApiSecret = input.internalApiSecret?.trim();
  if (surfaceUrl && internalApiSecret) {
    const surface = {
      surfaceUrl,
      internalApiSecret,
      ...(input.bearerToken !== undefined ? { bearerToken: input.bearerToken } : {}),
      ...(input.expectedProvider !== undefined ? { expectedProvider: input.expectedProvider } : {}),
    };
    env.sessionSandbox = createHttpSessionSandbox(surface);
    env.callbacks = createHttpCallbacks(surface);
  }

  return env;
}
