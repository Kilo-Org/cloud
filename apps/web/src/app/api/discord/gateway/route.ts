import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_BOT_TOKEN } from '@kilocode/web-shared/lib/config.server';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { discord_gateway_listener } from '@kilocode/db';
import {
  parseForwardedGatewayMessageEvent,
  type ForwardedGatewayEvent,
} from '@/lib/discord-bot/forwarded-gateway-event';
import { shouldProcessGatewayMessage } from '@/lib/discord-bot/gateway-message';

export const maxDuration = 800;

/**
 * Maximum duration for the Gateway listener (in ms).
 * On Vercel, this should be less than the function's maxDuration.
 * The cron job should run more frequently than this duration to ensure overlap.
 */
const GATEWAY_DURATION_MS = 770 * 1000; // ~12.8 minutes (30s buffer before 800s maxDuration)

/**
 * How often the listener checks if it's been superseded (in ms).
 * Lower = faster handoff, but more DB queries.
 */
const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
const MAX_IN_FLIGHT_FORWARDS = 8;
const FORWARD_TIMEOUT_MS = 10_000;

/**
 * Discord Gateway listener with Postgres-based coordination.
 *
 * Architecture:
 * - This route is triggered by a cron job (every 9 minutes)
 * - It connects to Discord's Gateway via WebSocket using discord.js
 * - Eligible bot mentions are sent to /discord/webhook for processing
 * - The listener runs for GATEWAY_DURATION_MS, then cleanly disconnects
 *
 * Coordination:
 * - On startup, the listener first connects to Discord and waits for ClientReady
 * - Only after a healthy connection does it claim the "active listener" slot in Postgres
 * - This prevents a failed startup from killing the previous active listener
 * - Each forward confirms current ownership on the primary database
 * - Heartbeats also check ownership while the connection is idle
 * - Listener shutdown cancels outstanding requests
 * - The webhook admits message IDs through a shared, expiring Redis claim
 * - Forwarding has a fixed in-flight limit and a per-request deadline
 */
export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized invocations
  const authHeader = request.headers.get('authorization');

  if (!CRON_SECRET) {
    return new NextResponse('CRON_SECRET not configured', { status: 500 });
  }

  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  if (!DISCORD_BOT_TOKEN) {
    return NextResponse.json({ error: 'DISCORD_BOT_TOKEN is not configured' }, { status: 500 });
  }

  const webhookUrl = `${APP_URL}/discord/webhook`;
  const listenerId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log('[DiscordGateway] Starting Gateway listener', { listenerId, webhookUrl });

  let abortController: AbortController | undefined;
  let heartbeatPromise: Promise<void> | undefined;

  try {
    abortController = new AbortController();

    // Run the Gateway listener. Leader takeover + heartbeat start only after
    // the Discord connection is healthy (ClientReady), so a failed login never
    // causes the previous listener to shut down prematurely.
    await runGatewayListener(webhookUrl, GATEWAY_DURATION_MS, abortController, listenerId, hp => {
      heartbeatPromise = hp;
    });

    return NextResponse.json({ status: 'completed', listenerId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[DiscordGateway] Gateway listener error:', errorMessage);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  } finally {
    // Always stop heartbeat polling, even if runGatewayListener rejects
    abortController?.abort();
    await heartbeatPromise?.catch(() => undefined);
  }
}

/**
 * Atomically claim the active listener slot using INSERT ... ON CONFLICT UPDATE.
 * This upserts the singleton row (id=1), replacing whatever listener was there before.
 */
async function claimActiveListener(listenerId: string, expiresAt: string): Promise<void> {
  await db
    .insert(discord_gateway_listener)
    .values({
      id: 1,
      listener_id: listenerId,
      started_at: new Date().toISOString(),
      expires_at: expiresAt,
    })
    .onConflictDoUpdate({
      target: discord_gateway_listener.id,
      set: {
        listener_id: listenerId,
        started_at: sql`now()`,
        expires_at: expiresAt,
      },
    });

  console.log('[DiscordGateway] Claimed active listener slot', { listenerId });
}

async function isActiveListener(listenerId: string): Promise<boolean> {
  const rows = await db
    .select({ listener_id: discord_gateway_listener.listener_id })
    .from(discord_gateway_listener)
    .where(
      sql`${discord_gateway_listener.id} = 1 AND ${discord_gateway_listener.expires_at} > now()`
    )
    .limit(1);
  return rows[0]?.listener_id === listenerId;
}

/**
 * Periodically check if this listener is still the active one.
 * If a newer listener has taken over, trigger the abort signal.
 */
async function runHeartbeat(listenerId: string, abortController: AbortController): Promise<void> {
  while (!abortController.signal.aborted) {
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        abortController.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, HEARTBEAT_INTERVAL_MS);
      abortController.signal.addEventListener('abort', done, { once: true });
    });

    if (abortController.signal.aborted) break;

    try {
      if (!(await isActiveListener(listenerId))) {
        console.log('[DiscordGateway] Listener ownership ended', { listenerId });
        abortController.abort();
        break;
      }
    } catch (error) {
      abortController.abort();
      console.error('[DiscordGateway] Heartbeat check failed:', error);
    }
  }
}

/**
 * Run the Discord Gateway listener for a specified duration.
 * Connects via discord.js, listens for raw events, and forwards
 * MESSAGE_CREATE events to the webhook URL.
 *
 * Leader takeover happens only after ClientReady so a failed login never
 * causes the previous listener to shut down prematurely.
 *
 * Respects the abort signal for clean shutdown when superseded.
 */
async function runGatewayListener(
  webhookUrl: string,
  durationMs: number,
  abortController: AbortController,
  listenerId: string,
  onHeartbeatStarted: (heartbeatPromise: Promise<void>) => void
): Promise<void> {
  const abortSignal = abortController.signal;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  let isShuttingDown = false;
  let botUserId: string | null = null;
  let isLeader = false;
  const inFlight = new Set<Promise<void>>();
  let droppedEvents = 0;
  let nextDropLogAt = 0;

  async function forwardMessage(event: ForwardedGatewayEvent): Promise<void> {
    try {
      if (!(await isActiveListener(listenerId))) {
        abortController.abort();
        return;
      }
    } catch (error) {
      console.error('[DiscordGateway] Ownership check failed:', error);
      abortController.abort();
      return;
    }

    if (abortSignal.aborted) return;

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-discord-gateway-token': DISCORD_BOT_TOKEN,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.any([abortSignal, AbortSignal.timeout(FORWARD_TIMEOUT_MS)]),
      });

      if (!response.ok) {
        console.error('[DiscordGateway] Failed to forward event:', response.status);
      }
      await response.body?.cancel();
    } catch (error) {
      if (!abortSignal.aborted) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[DiscordGateway] Error forwarding event:', errorMessage);
      }
    }
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => cleanup();
  const cleanup = (error?: unknown) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    isLeader = false;
    clearTimeout(timeout);
    abortSignal.removeEventListener('abort', onAbort);
    abortController.abort();
    console.log('[DiscordGateway] Listener stopped', { listenerId, droppedEvents });
    void (async () => {
      await client.destroy();
      await Promise.allSettled(inFlight);
      if (error !== undefined) reject(error);
      else resolve();
    })().catch(reject);
  };

  const timeout = setTimeout(() => {
    console.log('[DiscordGateway] Duration reached, disconnecting');
    cleanup();
  }, durationMs);

  if (abortSignal.aborted) {
    cleanup();
    return promise;
  }
  abortSignal.addEventListener('abort', onAbort, { once: true });

  client.once(Events.ClientReady, readyClient => {
    if (isShuttingDown) return;
    console.log('[DiscordGateway] Connected');
    botUserId = readyClient.user.id;

    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    claimActiveListener(listenerId, expiresAt)
      .then(() => {
        if (isShuttingDown) return;
        isLeader = true;
        onHeartbeatStarted(runHeartbeat(listenerId, abortController));
      })
      .catch(error => {
        console.error('[DiscordGateway] Failed to claim leader slot:', error);
        cleanup(error);
      });
  });

  client.on(Events.Error, error => {
    console.error('[DiscordGateway] Client error:', error.message);
  });

  client.on('raw', (packet: { t: string; d: unknown }) => {
    if (isShuttingDown || !isLeader || packet.t !== 'MESSAGE_CREATE') return;

    const event = parseForwardedGatewayMessageEvent({
      type: 'GATEWAY_MESSAGE_CREATE',
      timestamp: Date.now(),
      data: packet.d,
      botUserId,
    });
    if (!event || !shouldProcessGatewayMessage(event)) return;

    if (inFlight.size >= MAX_IN_FLIGHT_FORWARDS) {
      droppedEvents++;
      if (Date.now() >= nextDropLogAt) {
        nextDropLogAt = Date.now() + HEARTBEAT_INTERVAL_MS;
        console.warn('[DiscordGateway] Forward capacity reached', { listenerId, droppedEvents });
      }
      return;
    }

    const forward = forwardMessage(event);
    inFlight.add(forward);
    void forward.finally(() => inFlight.delete(forward));
  });

  client.login(DISCORD_BOT_TOKEN).catch(cleanup);
  return promise;
}
