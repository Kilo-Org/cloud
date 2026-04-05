import type { Hono } from 'hono';
import { timingSafeTokenEqual } from '../auth';
import type { Supervisor } from '../supervisor';
import { getBearerToken } from './gateway';

const PATCHABLE_KEYS = new Set(['KILOCODE_API_KEY']);

export function registerEnvRoutes(app: Hono, supervisor: Supervisor, expectedToken: string): void {
  app.use('/_kilo/env/*', async (c, next) => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.post('/_kilo/env/patch', async c => {
    let patch: unknown;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }

    const entries = Object.entries(patch as Record<string, unknown>);
    if (entries.length === 0) {
      return c.json({ error: 'Body must contain at least one key' }, 400);
    }

    const validated: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!PATCHABLE_KEYS.has(key)) {
        return c.json({ error: `Key '${key}' is not patchable` }, 400);
      }
      if (typeof value !== 'string') {
        return c.json({ error: `Value for '${key}' must be a string` }, 400);
      }
      validated[key] = value;
    }

    for (const [key, value] of Object.entries(validated)) {
      process.env[key] = value;
    }

    const signaled = supervisor.getState() === 'running' && supervisor.signal('SIGUSR1');

    console.log(
      '[controller] Env patched:',
      entries.map(([k]) => k).join(', '),
      'signaled:',
      signaled
    );
    return c.json({ ok: true, signaled });
  });
}
