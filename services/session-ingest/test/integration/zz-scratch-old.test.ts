import { env } from 'cloudflare:test';
import { describe, it } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { sql } from 'drizzle-orm';

describe('scratch: idle close', () => {
  it('runs one query and waits past the idle timer', async () => {
    const d = getWorkerDb(env.HYPERDRIVE.connectionString);
    await d.execute(sql`select 1`);
    console.log('query done, totalCount', d.$client.totalCount);
    await new Promise(r => setTimeout(r, 11_500));
    console.log('after wait, totalCount', d.$client.totalCount);
  }, 30_000);
});
