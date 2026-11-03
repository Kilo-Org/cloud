import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import { parseControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import {
  BITBUCKET_API_ORIGIN,
  BITBUCKET_GIT_ORIGIN,
  CURRENT_CAPABILITY_PREFIX,
  GITHUB_CAPABILITY_HOSTS,
} from '@kilocode/worker-utils/scm-capability-contract';

const SCM_HOSTS = {
  github: GITHUB_CAPABILITY_HOSTS,
  bitbucket: [new URL(BITBUCKET_GIT_ORIGIN).host, new URL(BITBUCKET_API_ORIGIN).host],
};

export function hasManagedScmCapability(grant: SessionCredentialGrant): boolean {
  const scm = grant.scm;
  const alias = scm?.alias && parseControlPlaneCredential(scm.alias);
  return Boolean(
    grant.containmentEnabled !== false &&
    grant.repository &&
    grant.repository.type === scm?.purpose &&
    (grant.repository.type !== 'github' || grant.repository.authentication === 'managed') &&
    scm &&
    scm.nativeToken === undefined &&
    scm.capability?.credential.startsWith(CURRENT_CAPABILITY_PREFIX[scm.purpose]) &&
    grant.outboundContainerId &&
    scm.capability.outboundContainerId === grant.outboundContainerId &&
    alias &&
    alias.sandboxId === grant.sandboxId &&
    alias.purpose === scm.purpose
  );
}

// This projects destinations, not repository permissions. Redemption remains the policy owner.
export function managedScmForwardingTargets(
  grants: readonly SessionCredentialGrant[],
  now = Date.now()
): string[] {
  const targets = new Set<string>();
  for (const grant of grants) {
    if (
      !hasManagedScmCapability(grant) ||
      grant.preparedAt > now ||
      grant.expiresAt <= now ||
      grant.members.length === 0
    )
      continue;
    const scm = grant.scm;
    if (!scm) continue;
    if (scm.purpose !== 'gitlab') {
      for (const host of SCM_HOSTS[scm.purpose]) targets.add(host);
      continue;
    }
    try {
      const instance = new URL(scm.gitlab?.instanceOrigin ?? '');
      const git = new URL(scm.gitUrl);
      if (
        instance.protocol !== 'https:' ||
        instance.username ||
        instance.password ||
        instance.search ||
        instance.hash ||
        instance.host !== scm.gitlab?.instanceHost ||
        instance.origin !== git.origin ||
        git.username ||
        git.password ||
        !scm.gitlab?.projectPath ||
        !scm.gitlab.integrationId ||
        !scm.gitlab.authType ||
        !scm.gitlab.identity
      )
        continue;
      targets.add(instance.host);
    } catch {
      continue;
    }
  }
  return [...targets].sort();
}

export function configuredVercelForwardUrl(
  env: { WORKER_URL?: string },
  logicalSandboxId: string
): string | null {
  if (!isSafeSandboxId(logicalSandboxId) || !env.WORKER_URL) return null;
  try {
    const base = new URL(env.WORKER_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
      return null;
    return new URL(`/scm/vercel/${encodeURIComponent(logicalSandboxId)}`, base).href;
  } catch {
    return null;
  }
}
