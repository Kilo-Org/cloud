import type { Context } from 'hono';
import type { AuthContext } from '../auth';
import { sandboxIdSchema } from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { userOwnsSandbox } from './sandbox-ownership';
import { pushBotStatus } from './event-push';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

// Skip the upstream webhook if the cached status is fresher than this — keeps
// per-sandbox QPS bounded when multiple clients (tabs, devices) poll in
// parallel. Slightly less than the 15s client poll interval so a single
// client's individual ticks always reach the bot.
const FRESH_STATUS_TTL_MS = 10_000;

/**
 * Client-driven bot-status nudge. The web/mobile client POSTs this every ~15s
 * while subscribed to a chat surface. Server side:
 *   1. authz: caller must own the sandbox,
 *   2. dedupe: skip if `SandboxStatusDO` has a fresh entry,
 *   3. fan out: tell the bot to push a fresh `bot.status` via the existing
 *      `KILOCLAW.deliverChatWebhook` rpc,
 *   4. failure escalation: on definitive bot-unreachable signals (no routing
 *      target, 4xx), publish `online: false` immediately so the UI flips
 *      without waiting for staleness inference.
 */
export async function handleRequestBotStatus(c: HonoCtx): Promise<Response> {
  const parsed = sandboxIdSchema.safeParse(c.req.param('sandboxId'));
  if (!parsed.success) return c.json({ error: 'Invalid sandboxId' }, 400);
  const sandboxId = parsed.data;

  const userId = c.get('callerId');
  const owns = await userOwnsSandbox(c.env, userId, sandboxId);
  if (!owns) return c.json({ error: 'forbidden' }, 403);

  const cached = await withDORetry(
    () => c.env.SANDBOX_STATUS_DO.get(c.env.SANDBOX_STATUS_DO.idFromName(sandboxId)),
    stub => stub.getBotStatus(),
    'SandboxStatusDO.getBotStatus'
  );
  const now = Date.now();
  if (cached && now - cached.updatedAt < FRESH_STATUS_TTL_MS) {
    // Cached status is fresh enough — another tab/device just nudged the bot.
    // The fan-out already pushed the event to all of this user's connections;
    // skipping here keeps webhook QPS at ~1 per 15s per sandbox regardless of
    // how many clients are subscribed.
    return c.json({ ok: true, dedupe: 'fresh' });
  }

  c.executionCtx.waitUntil(triggerBotStatusWebhook(c.env, sandboxId));
  return c.json({ ok: true });
}

/**
 * Sends a `bot.status_request` webhook to the kiloclaw plugin. On
 * definitively-bad responses, persists `online: false` so the UI flips
 * without waiting for the cache to age out.
 */
async function triggerBotStatusWebhook(env: Env, sandboxId: string): Promise<void> {
  try {
    await env.KILOCLAW.deliverChatWebhook({
      type: 'bot.status_request',
      targetBotId: `bot:kiloclaw:${sandboxId}`,
    });
  } catch (err) {
    if (isDefiniteUnreachable(err)) {
      logger.warn('bot.status_request: bot unreachable, publishing offline', {
        sandboxId,
        ...formatError(err),
      });
      try {
        await pushBotStatus(env, sandboxId, { online: false, at: Date.now() });
      } catch (pushErr) {
        logger.error('bot.status_request: pushBotStatus(offline) failed', {
          sandboxId,
          ...formatError(pushErr),
        });
      }
      return;
    }
    // Transient error (timeout, 5xx, network blip): leave the cached status
    // alone and let the next poll retry. Staleness will eventually surface
    // offline state on its own if the machine is genuinely dead.
    logger.warn('bot.status_request: transient delivery failure', {
      sandboxId,
      ...formatError(err),
    });
  }
}

// Definitive vs transient classification for the upstream RPC error. Strings
// come from `deliverChatWebhook` in services/kiloclaw/src/index.ts; treat
// "no routing target" / "no sandboxId" as definitive (the bot is gone), and
// any 4xx upstream as definitive (the controller actively rejected). Network
// errors and 5xx/timeouts stay transient.
export function isDefiniteUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('No routing target')) return true;
  if (msg.includes('has no sandboxId')) return true;
  const m = msg.match(/Webhook forward failed: (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    return code >= 400 && code < 500;
  }
  return false;
}
