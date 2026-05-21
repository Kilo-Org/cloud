import type { Context } from 'hono';
import type { z } from 'zod';
import type { AuthContext } from '../auth';
import {
  sandboxIdSchema,
  type RequestBotStatusResponse,
  type chatWebhookRpcSchema,
} from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { userOwnsSandbox } from './sandbox-ownership';
import { pushBotStatus } from './event-push';

type HonoCtx = Context<{ Bindings: Env; Variables: AuthContext }>;

// Skip the upstream webhook if the cached status is within this window — keeps
// per-sandbox QPS bounded when multiple clients (tabs, devices) poll in
// parallel. Slightly less than the 15s client poll interval so a single
// client's individual ticks always reach the bot.
const DEDUP_WINDOW_MS = 10_000;

// Return cached status as the immediate response payload when it is no older
// than this, so the UI can paint something while waiting for the fresh WS
// event. Records older than this are treated as too stale to render (matches
// the 90s staleness heuristic in the mobile bot-send-state component).
const TRUST_WINDOW_MS = 90_000;

/**
 * Client-driven bot-status nudge. The web/mobile client POSTs this every ~15s
 * while subscribed to a chat surface. Server side:
 *   1. authz: caller must own the sandbox,
 *   2. decision table (by cached record age):
 *      - within DEDUP_WINDOW_MS  → return cached, skip webhook (fresh enough)
 *      - within TRUST_WINDOW_MS  → return cached, trigger webhook (paint now + refresh)
 *      - older / absent          → return cached: null, trigger webhook (UI waits)
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
  const age = cached ? now - cached.updatedAt : Infinity;

  if (age <= DEDUP_WINDOW_MS) {
    // Cached status is fresh enough — another tab/device just nudged the bot.
    // The fan-out already pushed the event to all of this user's connections;
    // skipping here keeps webhook QPS at ~1 per 15s per sandbox regardless of
    // how many clients are subscribed.
    return c.json({ ok: true, cached } satisfies RequestBotStatusResponse);
  }

  const cachedToReturn = age <= TRUST_WINDOW_MS ? cached : null;
  c.executionCtx.waitUntil(triggerBotStatusWebhook(c.env, sandboxId));
  return c.json({ ok: true, cached: cachedToReturn } satisfies RequestBotStatusResponse);
}

/**
 * Sends a `bot.status_request` webhook to the kiloclaw plugin. On
 * definitively-bad responses, persists `online: false` so the UI flips
 * without waiting for the cache to age out.
 */
async function triggerBotStatusWebhook(env: Env, sandboxId: string): Promise<void> {
  try {
    const payload = {
      type: 'bot.status_request',
      targetBotId: `bot:kiloclaw:${sandboxId}`,
    } satisfies z.infer<typeof chatWebhookRpcSchema>;
    await env.KILOCLAW.deliverChatWebhook(payload);
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
// "no routing target" / "no sandboxId" / "is not running" as definitive
// (the bot is gone or suspended and won't autostart), and any 4xx upstream
// as definitive (the controller actively rejected). Network errors and
// 5xx/timeouts stay transient.
export function isDefiniteUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('No routing target')) return true;
  if (msg.includes('has no sandboxId')) return true;
  // `is not running` is thrown by deliverChatWebhook when the target
  // instance's DO status is anything other than 'running' (stopped,
  // provisioned, recovering, etc.). Match the prefix only so additional
  // status values introduced later still classify correctly without
  // requiring a lock-step update here. The full thrown shape is
  // "Instance for <label> is not running (status=<value>)".
  if (msg.includes('is not running')) return true;
  const m = msg.match(/Webhook forward failed: (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    return code >= 400 && code < 500;
  }
  return false;
}
