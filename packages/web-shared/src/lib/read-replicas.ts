import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * Every read replica the platform knows. `drizzle.ts` routes reads to the enabled ones and
 * `replication-health.ts` probes them, so both read this one list. The names match the
 * replication health alerts, so an operator can copy a name from an alert into
 * `POSTGRES_REPLICAS_DISABLED`.
 */
const KNOWN_READ_REPLICAS = [
  { name: 'us-west', side: 'us', urlVariable: 'POSTGRES_REPLICA_US_URL' },
  { name: 'eu-central-1', side: 'eu', urlVariable: 'POSTGRES_REPLICA_EU_URL' },
  { name: 'eu-central-2', side: 'eu', urlVariable: 'POSTGRES_REPLICA_EU_URL_2' },
] as const;

export const KNOWN_READ_REPLICA_COUNT = KNOWN_READ_REPLICAS.length;

export type ReadReplica = {
  name: string;
  side: 'us' | 'eu';
  url: string;
};

export type ReadReplicaInventory = {
  /** Replicas that have a URL and are not disabled. Reads and health probes use only these. */
  enabled: ReadReplica[];
  /** Known replica names listed in `POSTGRES_REPLICAS_DISABLED`. */
  disabled: string[];
  /** Names in `POSTGRES_REPLICAS_DISABLED` that match no known replica, usually a typo. */
  unknownDisabled: string[];
};

/**
 * Resolves the replica inventory from the environment. `POSTGRES_REPLICAS_DISABLED` is a
 * comma-separated list of replica names. A disabled replica keeps its URL variable, so it can be
 * enabled again by removing its name from the list. This never throws: drizzle.ts calls it at
 * module load, and a typo must not take down every instance. The health check reports
 * `unknownDisabled` instead.
 */
export function readReplicaInventory(getEnv = getEnvVariable): ReadReplicaInventory {
  const requested = new Set(
    getEnv('POSTGRES_REPLICAS_DISABLED')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
  );
  const known = new Set<string>(KNOWN_READ_REPLICAS.map(replica => replica.name));

  const enabled: ReadReplica[] = [];
  for (const { name, side, urlVariable } of KNOWN_READ_REPLICAS) {
    const url = getEnv(urlVariable);
    if (url && !requested.has(name)) enabled.push({ name, side, url });
  }

  return {
    enabled,
    disabled: [...requested].filter(name => known.has(name)),
    unknownDisabled: [...requested].filter(name => !known.has(name)),
  };
}
