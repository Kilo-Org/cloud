import type * as Affinity from '@kilocode/web-shared/lib/read-replica-affinity';
import type * as Drizzle from '@kilocode/web-shared/lib/drizzle';

const keys = [
  'KILO_GATEWAY_EU_REPLICA_AFFINITY',
  'VERCEL_REGION',
  'POSTGRES_REPLICA_EU_URL',
  'POSTGRES_REPLICA_EU_URL_2',
  'POSTGRES_REPLICA_US_URL',
] as const;

type ReplicaModules = {
  drizzle: typeof Drizzle;
  affinity: typeof Affinity;
};

async function withReplicas(
  { region, second, gateway = true }: { region: string; second?: string; gateway?: boolean },
  run: (modules: ReplicaModules) => void
) {
  const original = keys.map(key => [key, process.env[key]] as const);
  process.env.KILO_GATEWAY_EU_REPLICA_AFFINITY = gateway ? '1' : '0';
  process.env.VERCEL_REGION = region;
  process.env.POSTGRES_REPLICA_EU_URL = 'postgres://localhost/eu1';
  if (second) process.env.POSTGRES_REPLICA_EU_URL_2 = second;
  else delete process.env.POSTGRES_REPLICA_EU_URL_2;
  process.env.POSTGRES_REPLICA_US_URL = 'postgres://localhost/us';

  try {
    await jest.isolateModulesAsync(async () => {
      const drizzle = await import('@kilocode/web-shared/lib/drizzle');
      const affinity = await import('@kilocode/web-shared/lib/read-replica-affinity');
      try {
        run({ drizzle, affinity });
      } finally {
        await drizzle.closeAllDrizzleConnections();
      }
    });
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

it('uses the same EU pool for the same user across instances with different process defaults', async () => {
  function ownerDistribution({ drizzle, affinity }: ReplicaModules) {
    return Array.from({ length: 32 }, (_, i) =>
      affinity.runWithReplicaAffinity(`192.0.2.${i + 1}`, () => {
        affinity.setVerifiedReplicaUser(`user-${i}`);
        const { database, max } = drizzle.readDb.$client.options;
        expect(max).toBe(5);
        return database;
      })
    );
  }

  const hosts: (string | undefined)[][] = [];
  const random = jest.spyOn(Math, 'random');
  try {
    for (const roll of [0, 0.99]) {
      random.mockReturnValue(roll);
      await withReplicas({ region: 'fra1', second: 'postgres://localhost/eu2' }, modules => {
        expect(modules.drizzle.readDb.$client.options.database).toBe(roll === 0 ? 'eu1' : 'eu2');
        hosts.push(ownerDistribution(modules));
      });
    }
  } finally {
    random.mockRestore();
  }
  expect(hosts[1]).toEqual(hosts[0]);
  expect(new Set(hosts[0])).toEqual(new Set(['eu1', 'eu2']));
});

it.each([
  { region: 'sfo1', second: 'postgres://localhost/eu2', expected: 'us' },
  { region: 'fra1', second: 'postgres://localhost/eu1', expected: 'eu1' },
  { region: 'fra1', second: undefined, expected: 'eu1' },
  { region: 'fra1', second: 'postgres://localhost/eu2', gateway: false, expected: undefined },
])(
  'leaves $region single-pool and non-gateway behavior unchanged',
  async ({ expected, ...config }) => {
    await withReplicas(config, ({ drizzle, affinity }) => {
      const unscoped = drizzle.readDb.$client;
      expect(unscoped.options.max).toBe(10);
      if (expected) expect(unscoped.options.database).toBe(expected);
      affinity.runWithReplicaAffinity('192.0.2.1', () => {
        affinity.setVerifiedReplicaUser('some-user');
        expect(drizzle.readDb.$client).toBe(unscoped);
      });
    });
  }
);
