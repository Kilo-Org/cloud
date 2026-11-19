import { z } from 'zod';
import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import { ProviderCreationError } from './provider.js';
import { CLOUD_AGENT_SESSION_SYNC_ORIGIN } from '@kilocode/worker-utils/cloud-agent-session-sync';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';

/** The canonical effective allowlist of a sandbox, for every provider. */
export const nativeEgressAllowlistSchema = z
  .array(egressDomainSchema)
  .transform(domains => [...new Set(domains)].sort());

/** The shared egress check: http or https, the default port, no userinfo, an exact listed host. */
export function isAllowedEgressUrl(url: URL, allowlist: readonly string[]): boolean {
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  const hostname = egressDomainSchema.safeParse(url.hostname);
  return hostname.success && allowlist.includes(hostname.data);
}

const GIT_DOMAINS = [
  'github.com',
  'api.github.com',
  'uploads.github.com',
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
      CLOUD_AGENT_SESSION_SYNC_ORIGIN,
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
