import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import { nativeEgressAllowlistSchema } from '../sandbox-containers/egress-policy.js';
import { ProviderCreationError } from './provider.js';

const GIT_DOMAINS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'media.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'api.bitbucket.org',
];

export function buildNativeEgressAllowlist(input: {
  allowlist: string[];
  env: KiloTargetEnv & { WORKER_URL?: string };
  kiloToken?: string;
  repositoryUrl?: string;
}): string[] {
  const targets = deriveKiloSandboxTargets(input.env, input.kiloToken ?? '', {
    requireHttps: true,
  });
  if (!targets.success || !input.env.WORKER_URL) {
    throw new ProviderCreationError('invalid_configuration');
  }
  try {
    const urls = [
      input.env.WORKER_URL,
      ...Object.values(targets.targets),
      ...(input.repositoryUrl === undefined ? [] : [input.repositoryUrl]),
    ].map(value => new URL(value));
    if (
      urls.some(
        url =>
          url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== ''
      )
    ) {
      throw new ProviderCreationError('invalid_configuration');
    }
    return nativeEgressAllowlistSchema.parse([
      ...input.allowlist,
      ...GIT_DOMAINS,
      ...urls.map(url => url.hostname),
    ]);
  } catch {
    throw new ProviderCreationError('invalid_configuration');
  }
}
