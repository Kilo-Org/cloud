import { readReplicaInventory } from '@kilocode/web-shared/lib/read-replicas';

const ALL_URLS = {
  POSTGRES_REPLICA_US_URL: 'postgres://us',
  POSTGRES_REPLICA_EU_URL: 'postgres://eu-1',
  POSTGRES_REPLICA_EU_URL_2: 'postgres://eu-2',
};

function envOf(values: Record<string, string>) {
  return (key: string) => values[key] ?? '';
}

describe('readReplicaInventory', () => {
  it('enables every replica that has a URL when nothing is disabled', () => {
    expect(readReplicaInventory(envOf(ALL_URLS))).toEqual({
      enabled: [
        { name: 'us-west', side: 'us', url: 'postgres://us' },
        { name: 'eu-central-1', side: 'eu', url: 'postgres://eu-1' },
        { name: 'eu-central-2', side: 'eu', url: 'postgres://eu-2' },
      ],
      disabled: [],
      unknownDisabled: [],
    });
  });

  it('skips disabled replicas but keeps their URLs configured', () => {
    const inventory = readReplicaInventory(
      envOf({ ...ALL_URLS, POSTGRES_REPLICAS_DISABLED: ' eu-central-2 , us-west,' })
    );

    expect(inventory.enabled.map(replica => replica.name)).toEqual(['eu-central-1']);
    expect(inventory.disabled).toEqual(['eu-central-2', 'us-west']);
    expect(inventory.unknownDisabled).toEqual([]);
  });

  it('omits a replica without a URL without counting it as disabled', () => {
    const inventory = readReplicaInventory(envOf({ POSTGRES_REPLICA_EU_URL: 'postgres://eu-1' }));

    expect(inventory.enabled.map(replica => replica.name)).toEqual(['eu-central-1']);
    expect(inventory.disabled).toEqual([]);
  });

  it('reports unknown names instead of throwing', () => {
    const inventory = readReplicaInventory(
      envOf({ ...ALL_URLS, POSTGRES_REPLICAS_DISABLED: 'eu-central-3' })
    );

    expect(inventory.enabled).toHaveLength(3);
    expect(inventory.unknownDisabled).toEqual(['eu-central-3']);
  });
});
