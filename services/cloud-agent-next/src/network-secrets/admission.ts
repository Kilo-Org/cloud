import { decryptWithPrivateKey, timingSafeEqual } from '@kilocode/encryption';
import {
  assertNetworkSecretDestinations,
  NetworkSecretDestinationError,
} from '@kilocode/worker-utils/network-secrets';
import { ZodError } from 'zod';
import {
  withCredentialAdmission,
  type CredentialAuthority,
  type CredentialAdmissionContext,
  type CredentialAdmissionDependencies,
} from '../sandbox-control/credential-admission.js';
import { parseControlPlaneCredential } from '../shared/control-plane-credential.js';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import type { NetworkSecretGrant } from './grants.js';
import { resolvedNetworkSecretSchema, type NetworkSecretResolution } from './contract.js';

export type NetworkSecretAuthority = CredentialAuthority & {
  networkSecrets?: NetworkSecretGrant[];
  kilo?: Pick<SessionCredentialGrant['kilo'], 'targets'>;
  scm?: SessionCredentialGrant['scm'];
  additionalRepositories?: SessionCredentialGrant['additionalRepositories'];
};

export async function admitNetworkSecretCredential<
  G extends NetworkSecretAuthority,
  C extends CredentialAdmissionContext<G>,
>(
  credential: string,
  deps: CredentialAdmissionDependencies<G, C>,
  privateKey: string | undefined,
  excludedUrls: readonly string[],
  targetUrl: string
): Promise<NetworkSecretResolution | null> {
  const alias = parseControlPlaneCredential(credential);
  if (alias?.purpose !== 'secret') return null;
  const result = await withCredentialAdmission(
    deps,
    async (context, currentGrants): Promise<NetworkSecretResolution | null> => {
      if (context.provider !== 'cloudflare-containers' || alias.sandboxId !== context.sandboxId)
        return null;
      const grants = await currentGrants();
      for (const grant of grants ?? []) {
        for (const secret of grant.networkSecrets ?? []) {
          if (!timingSafeEqual(secret.alias, credential)) continue;
          try {
            assertNetworkSecretDestinations({ [secret.key]: secret }, [
              ...excludedUrls,
              ...Object.values(grant.kilo?.targets ?? {}),
              ...(grant.scm?.gitlab ? [grant.scm.gitlab.instanceOrigin] : []),
              ...(grant.additionalRepositories ?? []).flatMap(entry =>
                entry.scm.gitlab ? [entry.scm.gitlab.instanceOrigin] : []
              ),
            ]);
          } catch (error) {
            if (error instanceof ZodError || error instanceof NetworkSecretDestinationError)
              return { type: 'network-denied', key: secret.key, reason: 'policy_denied' };
            throw error;
          }
          const target = new URL(targetUrl);
          if (
            target.protocol !== 'https:' ||
            target.port !== '' ||
            target.username ||
            target.password ||
            !secret.allowedHosts.includes(target.hostname)
          ) {
            return { type: 'network-denied', key: secret.key, reason: 'host_mismatch' };
          }
          if (!privateKey) throw new Error('Network secret encryption key unavailable');
          const value = decryptWithPrivateKey(secret.envelope, privateKey);
          const latest = await currentGrants();
          if (!latest?.some(candidate => JSON.stringify(candidate) === JSON.stringify(grant)))
            return null;
          return resolvedNetworkSecretSchema.parse({
            type: 'network',
            key: secret.key,
            allowedHosts: secret.allowedHosts,
            locations: secret.locations,
            value,
          });
        }
      }
      return null;
    }
  );
  return result && 'type' in result ? result : null;
}
