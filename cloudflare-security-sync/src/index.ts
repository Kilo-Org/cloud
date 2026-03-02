import { z } from 'zod';
import { getWorkerDb } from '@kilocode/db/client';
import { agent_configs } from '@kilocode/db/schema';
import { eq, and, isNotNull, or } from 'drizzle-orm';
import { syncOwner } from './sync';

const SecuritySyncMessageSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  messageId: z.string().min(1),
  owner: z
    .object({
      organizationId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
    })
    .refine(value => Boolean(value.organizationId || value.userId), {
      message: 'owner.organizationId or owner.userId is required',
    }),
  ownerKey: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  dispatchedAt: z.string().datetime(),
});

export type SecuritySyncMessage = z.infer<typeof SecuritySyncMessageSchema>;

type OwnerEntry = {
  owner: { organizationId?: string; userId?: string };
  ownerKey: string;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const QUEUE_SEND_BATCH_LIMIT = 100;

async function enqueueOwners(
  queue: Queue<SecuritySyncMessage>,
  runId: string,
  dispatchedAt: string,
  owners: OwnerEntry[]
): Promise<number> {
  if (owners.length === 0) return 0;

  const messages: MessageSendRequest<SecuritySyncMessage>[] = owners.map(({ owner, ownerKey }) => ({
    body: {
      schemaVersion: 1,
      runId,
      messageId: `${runId}:${ownerKey}:0`,
      owner,
      ownerKey,
      chunkIndex: 0,
      chunkCount: 1,
      dispatchedAt,
    },
    contentType: 'json',
  }));

  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_LIMIT));
  }

  return messages.length;
}

async function sendBetterStackHeartbeat(
  heartbeatUrl: string | undefined,
  failed: boolean
): Promise<void> {
  if (!heartbeatUrl) return;
  const url = failed ? `${heartbeatUrl}/fail` : heartbeatUrl;
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    // best-effort
  }
}

function resolveOwner(
  raw: SecuritySyncMessage['owner']
): { organizationId: string } | { userId: string } | null {
  if (raw.organizationId) return { organizationId: raw.organizationId };
  if (raw.userId) return { userId: raw.userId };
  return null;
}

async function processSecuritySyncMessage(
  message: Message<SecuritySyncMessage>,
  env: CloudflareEnv
): Promise<void> {
  const parsed = SecuritySyncMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    console.error('Invalid security sync queue message', { errors: parsed.error.issues });
    message.ack();
    return;
  }

  const body = parsed.data;

  console.info('Security sync queue message received', {
    runId: body.runId,
    ownerKey: body.ownerKey,
    messageId: body.messageId,
  });

  const owner = resolveOwner(body.owner);
  if (!owner) {
    console.error('Owner has neither organizationId nor userId', { messageId: body.messageId });
    message.ack();
    return;
  }

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  const startTime = Date.now();

  const result = await syncOwner({
    db,
    gitTokenService: env.GIT_TOKEN_SERVICE,
    owner,
    runId: body.runId,
  });

  console.info('Security sync completed for owner', {
    runId: body.runId,
    ownerKey: body.ownerKey,
    synced: result.synced,
    errors: result.errors,
    staleRepos: result.staleRepos,
    durationMs: Date.now() - startTime,
  });

  message.ack();
}

export default {
  async fetch(request: Request, _env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'cloudflare-security-sync',
        timestamp: new Date().toISOString(),
      });
    }

    return jsonResponse({ success: false, error: 'Not found' }, 404);
  },

  async scheduled(_controller: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    const runId = crypto.randomUUID();
    let failed = false;

    try {
      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
      const rows = await db
        .select({
          owned_by_organization_id: agent_configs.owned_by_organization_id,
          owned_by_user_id: agent_configs.owned_by_user_id,
        })
        .from(agent_configs)
        .where(
          and(
            eq(agent_configs.agent_type, 'security_scan'),
            eq(agent_configs.platform, 'github'),
            eq(agent_configs.is_enabled, true),
            or(
              isNotNull(agent_configs.owned_by_organization_id),
              isNotNull(agent_configs.owned_by_user_id)
            )
          )
        );

      const deduplicated = new Map<string, OwnerEntry>();
      for (const row of rows) {
        if (row.owned_by_organization_id) {
          const key = `org:${row.owned_by_organization_id}`;
          if (!deduplicated.has(key)) {
            deduplicated.set(key, {
              owner: { organizationId: row.owned_by_organization_id },
              ownerKey: key,
            });
          }
        } else if (row.owned_by_user_id) {
          const key = `user:${row.owned_by_user_id}`;
          if (!deduplicated.has(key)) {
            deduplicated.set(key, {
              owner: { userId: row.owned_by_user_id },
              ownerKey: key,
            });
          }
        }
      }

      const owners = [...deduplicated.values()];
      const enqueuedMessages = await enqueueOwners(
        env.SYNC_QUEUE,
        runId,
        new Date().toISOString(),
        owners
      );

      console.info('Security sync scheduled dispatch completed', {
        runId,
        ownerCount: owners.length,
        enqueuedMessages,
      });
    } catch (error) {
      failed = true;
      console.error('Security sync scheduled dispatch failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      ctx.waitUntil(sendBetterStackHeartbeat(env.SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL, failed));
    }
  },

  async queue(batch: MessageBatch<SecuritySyncMessage>, env: CloudflareEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processSecuritySyncMessage(message, env);
      } catch (error) {
        console.error('Security sync queue processing failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};
