import {
  pool,
  db,
  selectReplicaUrl,
  selectUsageReplicaUrl,
  shouldExitOnPoolError,
} from '@/lib/drizzle';

describe('drizzle', () => {
  describe('pool', () => {
    it('should have application_name set', async () => {
      const client = await pool.connect();
      const res = await client.query("SELECT current_setting('application_name')");
      expect(res.rows[0].current_setting).toBe('kilocode-web');
      client.release();
    });
  });

  it('should use application name', async () => {
    const res = await db.execute("SELECT current_setting('application_name')");
    expect(res.rows[0].current_setting).toBe('kilocode-web');
  });

  describe('pool error listeners', () => {
    it('attaches a non-exiting error listener in test mode', () => {
      // If no listener is attached, Node treats an 'error' emit as a throw.
      // In test mode, pool.end() during cleanup triggers idle client errors
      // that must not crash the test runner.
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
    });

    it('does not throw on an idle-client error in test mode', () => {
      // The test-mode handler catches errors without exit.
      // Verifying the emit does not throw proves the listener works.
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => pool.emit('error', new Error('idle client disconnect'))).not.toThrow();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('exits on a primary pool error outside test mode', () => {
      // A dead primary pool means the process cannot serve traffic at all.
      expect(shouldExitOnPoolError('primary', 'production')).toBe(true);
    });

    it('does not exit on a replica pool error outside test mode', () => {
      // Regression guard: exiting here escalated a replica-only outage into 107
      // instance terminations on 2026-08-12 while the primary was healthy.
      // The replica is a read-path optimisation with a primary fallback, so a
      // broken replica must degrade reads rather than kill the process.
      expect(shouldExitOnPoolError('replica', 'production')).toBe(false);
    });

    it('never exits in test mode, so pool.end() cleanup cannot kill the runner', () => {
      expect(shouldExitOnPoolError('primary', 'test')).toBe(false);
      expect(shouldExitOnPoolError('replica', 'test')).toBe(false);
    });
  });

  describe('replica selection', () => {
    const primaryUrl = 'postgres://primary';

    it('uses the primary in local development even when replicas are configured', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'development',
          vercelRegion: undefined,
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe(primaryUrl);
    });

    it('preserves EU replica selection for regionless non-development processes', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: undefined,
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
          random: () => 0,
        })
      ).toBe('postgres://eu-replica');
    });

    it('uses the US replica in a US Vercel region', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'iad1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe('postgres://us-replica');
    });

    it('selects between EU replicas in an EU Vercel region', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'fra1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: ['postgres://eu-1', 'postgres://eu-2'],
          random: () => 0.75,
        })
      ).toBe('postgres://eu-2');
    });

    it('uses the dedicated usage replica when configured', () => {
      expect(
        selectUsageReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          usageReplicaUrl: 'postgres://eu-2',
          fallbackReplicaUrl: 'postgres://eu-1',
        })
      ).toBe('postgres://eu-2');
    });

    it('falls back to the standard replica when the usage replica is unset', () => {
      expect(
        selectUsageReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          usageReplicaUrl: undefined,
          fallbackReplicaUrl: 'postgres://eu-1',
        })
      ).toBe('postgres://eu-1');
    });

    it('uses the primary for usage reads in local development', () => {
      expect(
        selectUsageReplicaUrl({
          primaryUrl,
          nodeEnv: 'development',
          usageReplicaUrl: 'postgres://eu-2',
          fallbackReplicaUrl: 'postgres://eu-1',
        })
      ).toBe(primaryUrl);
    });

    it('falls back to the primary when the regional replica is unavailable', () => {
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'iad1',
          usReplicaUrl: undefined,
          euReplicaUrls: ['postgres://eu-replica'],
        })
      ).toBe(primaryUrl);
      expect(
        selectReplicaUrl({
          primaryUrl,
          nodeEnv: 'production',
          vercelRegion: 'fra1',
          usReplicaUrl: 'postgres://us-replica',
          euReplicaUrls: [],
        })
      ).toBe(primaryUrl);
    });
  });
});
