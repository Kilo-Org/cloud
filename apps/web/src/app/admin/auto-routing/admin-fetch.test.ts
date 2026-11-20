import { describe, expect, it } from '@jest/globals';
import * as z from 'zod';
import { parseAdminResponse } from './admin-fetch';

const schema = z.object({ ok: z.literal(true) });

describe('parseAdminResponse', () => {
  it('parses a successful body with the response schema', async () => {
    await expect(parseAdminResponse(Response.json({ ok: true }), schema)).resolves.toEqual({
      ok: true,
    });
  });

  it('shows the worker message alongside its error', async () => {
    const response = Response.json(
      { error: 'Internal server error', message: 'D1 DB is overloaded' },
      { status: 500 }
    );

    await expect(parseAdminResponse(response, schema)).rejects.toThrow(
      new Error('Internal server error: D1 DB is overloaded')
    );
  });

  it('shows an error without a message as is', async () => {
    const response = Response.json({ error: 'Invalid router' }, { status: 400 });

    await expect(parseAdminResponse(response, schema)).rejects.toThrow(new Error('Invalid router'));
  });

  it('reports a non-JSON error body by its status instead of a parse error', async () => {
    const response = new Response('<html>Gateway Timeout</html>', { status: 504 });

    await expect(parseAdminResponse(response, schema)).rejects.toThrow(
      new Error('Request failed: 504')
    );
  });
});
