import { env } from 'cloudflare:test';
import { describe, it } from 'vitest';
import { pg } from '@kilocode/db/client';

describe('scratch: plain pg Client close', () => {
  it('connects, queries, ends with an error listener', async () => {
    const client = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
    const errors: string[] = [];
    client.on('error', e => errors.push(e.message));
    await client.connect();
    await client.query('select 1');
    await client.end();
    await new Promise(r => setTimeout(r, 300));
    throw new Error('DIAG ' + JSON.stringify({ errors, d: (globalThis as { __d?: string[] }).__d }));
  });
});
