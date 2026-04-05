import { pool, db } from '@/lib/drizzle';

describe('drizzle', () => {
  describe('pool', () => {
    it('should have application_name set', async () => {
      const client = await pool.connect();
      const res = await client.query("SELECT current_setting('application_name')");
      expect(res.rows[0].current_setting).toBe('kilocode-backend');
      client.release();
    });
  });

  it('should use application name', async () => {
    const res = await db.execute("SELECT current_setting('application_name')");
    expect(res.rows[0].current_setting).toBe('kilocode-backend');
  });
});
