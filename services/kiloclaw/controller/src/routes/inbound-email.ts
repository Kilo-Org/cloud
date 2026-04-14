import type { Hono } from 'hono';
import type { Supervisor } from '../supervisor';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

const GATEWAY_HOOK_URL = 'http://127.0.0.1:3001/hooks/email';

export function registerInboundEmailRoute(
  app: Hono,
  supervisor: Supervisor,
  expectedToken: string,
  hooksToken: string
): void {
  app.post('/_kilo/hooks/email', async c => {
    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (supervisor.getState() !== 'running') {
      return c.json({ error: 'Gateway not ready' }, 503);
    }

    try {
      const upstream = await fetch(GATEWAY_HOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          authorization: `Bearer ${hooksToken}`,
        },
        body: c.req.raw.body,
        duplex: 'half',
      } as RequestInit);

      const upstreamBody = await upstream.text();

      if (upstream.ok) {
        return c.json({ ok: true, hookStatus: upstream.status }, upstream.status as 200 | 202);
      }

      if (upstream.status >= 400 && upstream.status < 500) {
        console.warn(
          `[inbound-email] Hook rejected ${upstream.status}: ${upstreamBody.slice(0, 500)}`
        );
        return c.json(
          { error: 'Hook rejected', hookStatus: upstream.status },
          upstream.status as 400
        );
      }

      console.error(`[inbound-email] Hook error ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
      return c.json({ error: 'Hook upstream error', hookStatus: upstream.status }, 500);
    } catch (err) {
      console.error('[inbound-email] Failed to reach gateway hook endpoint:', err);
      return c.json({ error: 'Gateway hook endpoint unreachable' }, 500);
    }
  });
}
