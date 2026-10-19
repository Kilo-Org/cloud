import type { AgentSandboxProvider, Env } from '../types.js';
import { ProviderCreationError } from './provider.js';

export type StartupMode = 'preinstalled' | 'downloaded';
export type NativeRuntimeImage = 'all-in-one' | 'runtime-free';
export type StartupSelection =
  | { mode: 'preinstalled'; image: NativeRuntimeImage }
  | { mode: 'downloaded'; image: NativeRuntimeImage; descriptor: string };

/** Resolve trusted deployment configuration once per create attempt. */
export function selectStartup(
  env: Pick<Env, 'RUNTIME_STARTUP_MODE' | 'NATIVE_RUNTIME_IMAGE' | 'RUNTIME_RELEASE_DESCRIPTOR'>,
  provider: AgentSandboxProvider
): StartupSelection {
  const mode = env.RUNTIME_STARTUP_MODE ?? 'preinstalled';
  const image = env.NATIVE_RUNTIME_IMAGE ?? 'all-in-one';
  if (
    (mode !== 'preinstalled' && mode !== 'downloaded') ||
    (image !== 'all-in-one' && image !== 'runtime-free') ||
    (image === 'runtime-free' && mode !== 'downloaded')
  )
    throw new ProviderCreationError('invalid_configuration');
  // Downloaded startup is native-only. SDK and Vercel pins keep preinstalled startup.
  if (mode === 'preinstalled' || provider !== 'cloudflare-containers')
    return { mode: 'preinstalled', image };
  if (!env.RUNTIME_RELEASE_DESCRIPTOR) throw new ProviderCreationError('invalid_configuration');
  return { mode, image, descriptor: env.RUNTIME_RELEASE_DESCRIPTOR };
}

/** Preserve legacy preinstalled snapshot keys. Downloaded snapshots have a separate namespace. */
export function startupRepositoryKey(repoKey: string, mode: StartupMode): string {
  return mode === 'preinstalled' ? repoKey : `downloaded:${repoKey}`;
}
