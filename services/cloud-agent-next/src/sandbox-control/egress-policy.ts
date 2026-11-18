import { z } from 'zod';
import { deriveKiloSandboxTargets, type KiloTargetEnv } from '../kilo/kilo-targets.js';
import { ProviderCreationError } from './provider.js';
import { runtimeCredentialProxyFacadeBaseUrl } from '../runtime-credential-proxy.js';
import { CLOUD_AGENT_SESSION_SYNC_ORIGIN } from '@kilocode/worker-utils/cloud-agent-session-sync';
import { egressDomainSchema, type EgressMode } from '@kilocode/worker-utils/egress-allowlist';

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

type AllowlistContext = {
  env: KiloTargetEnv & { WORKER_URL?: string };
  repositoryUrl?: string;
};

function compileAllowlist(allowlist: string[], targets: string[]): string[] {
  try {
    const urls = targets.map(value => new URL(value));
    if (urls.some(url => url.protocol !== 'https:' || url.port || url.username || url.password))
      throw new ProviderCreationError('invalid_configuration');
    return nativeEgressAllowlistSchema.parse([
      ...allowlist,
      ...GIT_DOMAINS,
      ...urls.map(url => url.hostname),
    ]);
  } catch {
    throw new ProviderCreationError('invalid_configuration');
  }
}

/** The runtime uses only the facade. Upstream model and ingest requests run inside the Worker. */
export function buildNativeEgressAllowlist(
  input: AllowlistContext & { allowlist: string[]; kiloToken?: string }
): string[] {
  const facade = input.env.WORKER_URL && runtimeCredentialProxyFacadeBaseUrl(input.env.WORKER_URL);
  if (!facade) throw new ProviderCreationError('invalid_configuration');
  return compileAllowlist(input.allowlist, [
    facade,
    CLOUD_AGENT_SESSION_SYNC_ORIGIN,
    ...(input.repositoryUrl === undefined ? [] : [input.repositoryUrl]),
  ]);
}

type EgressPin = { egressAllowlist?: readonly string[]; egressAudit?: boolean };
type EgressRequest = { egressMode?: EgressMode; egressAllowlist?: string[]; egressAudit?: boolean };

/**
 * Match the deployed baseline only for an immutable active pin. Never rewrite that pin or broaden its access.
 * The pre-facade reconstruction uses the current backend, provider and ingest URLs and the session token.
 * If a deployment changes one of them, an active pre-facade allocation fails prepare with
 * `invalid_configuration`. The next allocation after it stops uses the facade baseline.
 */
export function matchesActiveEgressPolicy(
  input: AllowlistContext & {
    stored: EgressPin | null;
    selected: EgressPin | undefined;
    request: EgressRequest | undefined;
    kiloToken?: string;
  }
): boolean {
  if ((input.stored?.egressAudit === true) !== (input.selected?.egressAudit === true)) return false;
  const stored = input.stored?.egressAllowlist;
  if (JSON.stringify(stored) === JSON.stringify(input.selected?.egressAllowlist)) return true;
  if (!stored || !input.selected?.egressAllowlist || input.request?.egressMode !== 'allowlist')
    return false;
  // Prior releases included Worker-side upstream targets. Reconstruct that exact request for comparison only.
  const targets = deriveKiloSandboxTargets(input.env, input.kiloToken ?? '', {
    requireHttps: true,
  });
  if (!targets.success || !input.env.WORKER_URL) return false;
  try {
    const previous = compileAllowlist(input.request.egressAllowlist ?? [], [
      input.env.WORKER_URL,
      CLOUD_AGENT_SESSION_SYNC_ORIGIN,
      ...Object.values(targets.targets),
      ...(input.repositoryUrl === undefined ? [] : [input.repositoryUrl]),
    ]);
    return JSON.stringify(previous) === JSON.stringify(stored);
  } catch {
    return false;
  }
}
