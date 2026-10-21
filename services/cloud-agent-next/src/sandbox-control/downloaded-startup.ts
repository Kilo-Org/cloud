import { resolveSecret } from '../auth.js';
import type { Env } from '../types.js';
import { ProviderCreationError, type ProviderStartupCommand } from './provider.js';
import { loadRuntimeRelease } from './runtime-release-loader.js';
import { mintRuntimeArtifactGrant } from './runtime-artifact-grant.js';
import { renderRuntimeBootstrap } from './runtime-bootstrap.js';
import {
  runtimeArtifactForRole,
  RUNTIME_ARTIFACT_HTTP_PREFIX,
  serializeRuntimeRelease,
} from './runtime-release.js';

export async function downloadedStartup(input: {
  env: Pick<Env, 'WORKER_URL' | 'NEXTAUTH_SECRET' | 'RUNTIME_RELEASE_BUCKET'>;
  descriptor: string;
  sandboxId: string;
  allocationId: string;
  deadlineAt: number;
}): Promise<ProviderStartupCommand> {
  const release = await loadRuntimeRelease(input.descriptor, input.env.RUNTIME_RELEASE_BUCKET);
  const secret = await resolveSecret(input.env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Runtime signing unavailable');
  const grant = mintRuntimeArtifactGrant(
    [
      runtimeArtifactForRole(release, 'cli').sha256,
      runtimeArtifactForRole(release, 'control').sha256,
    ],
    secret,
    input.deadlineAt
  );
  let command: ProviderStartupCommand;
  try {
    command = renderRuntimeBootstrap({
      descriptor: new TextDecoder().decode(serializeRuntimeRelease(release)),
      artifactBaseUrl: new URL(RUNTIME_ARTIFACT_HTTP_PREFIX, input.env.WORKER_URL).toString(),
      reportUrl: new URL(
        `/sandbox-control/${encodeURIComponent(input.sandboxId)}/startup-failure`,
        input.env.WORKER_URL
      ).toString(),
      allocationId: input.allocationId,
      grant,
      deadlineAt: input.deadlineAt,
    });
  } catch {
    throw new ProviderCreationError('invalid_configuration');
  }
  if (command.argv.some(arg => new TextEncoder().encode(arg).byteLength >= 128 * 1024))
    throw new ProviderCreationError('invalid_configuration');
  return command;
}
