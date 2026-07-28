import { pool, db, selectReplicaUrl } from '@/lib/drizzle';

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
