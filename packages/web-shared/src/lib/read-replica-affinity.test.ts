import {
  createReadReplicaFacade,
  readReplicaCacheKey,
  replicaAffinityHash,
  runWithReplicaAffinity,
  setVerifiedReplicaUser,
} from '@kilocode/web-shared/lib/read-replica-affinity';

describe('request replica affinity', () => {
  function userHash(userId: string, ip?: string) {
    return runWithReplicaAffinity(ip, () => {
      setVerifiedReplicaUser(userId);
      return replicaAffinityHash();
    });
  }

  it('prefers the verified account regardless of client IP and distributes users between two replicas', () => {
    expect(userHash('account-1', '192.0.2.1')).toBe(userHash('account-1', '192.0.2.2'));
    const indexes = Array.from({ length: 100 }, (_, i) => (userHash(`account-${i}`) ?? 0) % 2);
    expect(indexes.filter(index => index === 0).length).toBeGreaterThan(25);
    expect(indexes.filter(index => index === 1).length).toBeGreaterThan(25);
  });

  it('keeps overlapping requests separate and falls back to an IP or no key', async () => {
    const ip = '192.0.2.3';
    const ipHash = runWithReplicaAffinity(ip, replicaAffinityHash);
    expect(ipHash).toEqual(expect.any(Number));
    const results = await Promise.all([
      runWithReplicaAffinity(ip, async () => {
        const beforeAuth = replicaAffinityHash();
        setVerifiedReplicaUser('account-1');
        await Promise.resolve();
        return [beforeAuth, replicaAffinityHash()];
      }),
      runWithReplicaAffinity(ip, async () => {
        await Promise.resolve();
        return [replicaAffinityHash(), replicaAffinityHash()];
      }),
    ]);
    expect(results).toEqual([
      [ipHash, userHash('account-1')],
      [ipHash, ipHash],
    ]);
    expect(runWithReplicaAffinity(undefined, replicaAffinityHash)).toBeUndefined();
    expect(replicaAffinityHash()).toBeUndefined();
  });
});

describe('read replica facade', () => {
  function client(replica: string) {
    return {
      replica,
      query: { replica },
      execute() {
        return { replica: this.replica, run: () => Promise.resolve(this.replica) };
      },
    };
  }

  it('captures the real client when building a query and separates cache keys', async () => {
    const first = client('first');
    const second = client('second');
    const readDb = createReadReplicaFacade(first, () =>
      replicaAffinityHash() === undefined ? first : second
    );
    expect(readReplicaCacheKey(first)).toBe(first);
    expect(readReplicaCacheKey(readDb)).toBe(first);
    const builder = runWithReplicaAffinity('192.0.2.1', () => {
      expect(readReplicaCacheKey(readDb)).toBe(second);
      expect(readDb.query).toBe(second.query);
      return readDb.execute();
    });
    expect(readDb.query).toBe(first.query);
    await expect(builder.run()).resolves.toBe('second');
    await expect(readDb.execute().run()).resolves.toBe('first');
  });
});
