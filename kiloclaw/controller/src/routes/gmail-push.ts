import type { Hono } from 'hono';
import type { Supervisor } from '../supervisor';
import { timingSafeTokenEqual } from '../auth';
import { getBearerToken } from './gateway';

const GMAIL_WATCH_PORT = 3002;

export function registerGmailPushRoute(
  app: Hono,
  gmailWatchSupervisor: Supervisor | null,
  expectedToken: string
): void {
  app.post('/_kilo/gmail-pubsub', async c => {
    if (!gmailWatchSupervisor) {
      return c.json({ error: 'Gmail watch not configured' }, 404);
    }

    const token = getBearerToken(c.req.header('authorization'));
    if (!token || !timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (gmailWatchSupervisor.getState() !== 'running') {
      return c.json({ error: 'Gmail watch process not running' }, 503);
    }

    try {
      const upstream = await fetch(`http://127.0.0.1:${GMAIL_WATCH_PORT}/gmail-pubsub`, {
        method: 'POST',
        headers: {
          'content-type': c.req.header('content-type') ?? 'application/json',
          'x-gog-token': expectedToken,
        },
        body: c.req.raw.body,
        // Required for streaming body in Node.js fetch
        duplex: 'half',
      } as RequestInit);

      const upstreamBody = await upstream.text();

      if (upstream.ok) {
        // 200 = hook delivered, 202 = no new messages (filtered/duplicate/mismatch)
        console.log(`[gmail-push] gog responded ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
        return c.json({ ok: true, gogStatus: upstream.status }, upstream.status as 200 | 202);
      }

      // 4xx = permanently rejected, return 200 so Pub/Sub doesn't retry
      if (upstream.status >= 400 && upstream.status < 500) {
        console.warn(`[gmail-push] gog rejected ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
        return c.json({ ok: true, gogStatus: upstream.status }, 200);
      }

      // 5xx = transient error, return 500 so Pub/Sub retries
      console.error(`[gmail-push] gog error ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
      return c.json({ error: 'Upstream error', gogStatus: upstream.status }, 500);
    } catch (err) {
      console.error('[gmail-push] Failed to reach gmail watch process:', err);
      return c.json({ error: 'Gmail watch process unreachable' }, 500);
    }
  });
}
