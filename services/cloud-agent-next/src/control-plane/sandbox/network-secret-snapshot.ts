import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  mintNetworkSecretGrants,
  networkSecretGrantsSchema,
  type NetworkSecretGrant,
} from '../../network-secrets/grants.js';
import { networkSecretSnapshots } from './sqlite-schema.js';
import type { Env } from '../../types.js';
import type { ControlPlaneCredentialSource } from '../../shared/control-plane-protocol.js';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import { networkSecretExcludedUrls } from '../../network-secrets/grants.js';
import { NetworkSecretConfigurationError } from '../../network-secrets/errors.js';

export function networkSecretSnapshot(
  db: Pick<ReturnType<typeof drizzle>, 'select' | 'insert'>,
  input: { scopeId: string; sandboxId: string; secrets: unknown; excludedUrls: readonly string[] }
): NetworkSecretGrant[] {
  const saved = db
    .select()
    .from(networkSecretSnapshots)
    .where(eq(networkSecretSnapshots.scope_id, input.scopeId))
    .get();
  if (saved) {
    try {
      return networkSecretGrantsSchema.parse(JSON.parse(saved.secrets));
    } catch {
      throw new NetworkSecretConfigurationError();
    }
  }
  const secrets = mintNetworkSecretGrants(input.sandboxId, input.secrets, input.excludedUrls);
  db.insert(networkSecretSnapshots)
    .values({ scope_id: input.scopeId, secrets: JSON.stringify(secrets) })
    .run();
  return secrets;
}

export function deleteNetworkSecretSnapshot(
  db: Pick<ReturnType<typeof drizzle>, 'delete'>,
  scopeId: string
): void {
  db.delete(networkSecretSnapshots).where(eq(networkSecretSnapshots.scope_id, scopeId)).run();
}

export function routeNetworkSecretSnapshot(
  db: Pick<ReturnType<typeof drizzle>, 'select' | 'insert'>,
  input: {
    env: Env;
    source: ControlPlaneCredentialSource;
    sandboxId: string;
    sessionId: string;
    environment?: SessionEnvironmentReference | null;
  }
): NetworkSecretGrant[] {
  return networkSecretSnapshot(db, {
    scopeId: input.source.scopeId ?? input.sessionId,
    sandboxId: input.sandboxId,
    secrets: input.source.networkSecrets,
    excludedUrls:
      Object.keys(input.source.networkSecrets ?? {}).length === 0
        ? []
        : networkSecretExcludedUrls(
            input.env,
            input.source,
            (input.environment?.repositories ?? []).flatMap(repository =>
              repository.identity.platform === 'gitlab' ? [repository.identity.cloneUrl] : []
            )
          ),
  });
}
