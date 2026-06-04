import { timingSafeEqual as nodeTimingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  createSecurityAgentCommand,
  markSecurityAgentCommandQueueAdmissionFailed,
  transitionSecurityAgentCommand,
  type SecurityAgentCommandOwner,
} from '@kilocode/db';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { agent_configs } from '@kilocode/db/schema';
import { eq, and, isNotNull, or } from 'drizzle-orm';
import { syncOwner } from './sync';
import { processSecurityFindingDismissal } from './dismiss';

const SecuritySyncOwnerSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    userId: z.string().min(1).optional(),
  })
  .refine(value => Boolean(value.organizationId) !== Boolean(value.userId), {
    message: 'exactly one of owner.organizationId or owner.userId is required',
  });

const SecuritySyncActorSchema = z.object({
  id: z.string().min(1),
  email: z.string().email().nullable().optional(),
  name: z.string().min(1).nullable().optional(),
});

const SecuritySyncMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: z.string().uuid().optional(),
    runId: z.string().uuid(),
    messageId: z.string().min(1),
    trigger: z.enum(['scheduled', 'manual']),
    owner: SecuritySyncOwnerSchema,
    ownerKey: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    dispatchedAt: z.string().datetime(),
    actor: SecuritySyncActorSchema.optional(),
    repoFullName: z.string().min(1).optional(),
  })
  .refine(message => message.trigger === 'scheduled' || Boolean(message.commandId), {
    message: 'commandId is required for manual sync commands',
    path: ['commandId'],
  });

const ManualSecuritySyncCommandSchema = z.object({
  schemaVersion: z.literal(1),
  owner: SecuritySyncOwnerSchema,
  actor: SecuritySyncActorSchema,
  origin: z.enum(['manual', 'dashboard_refresh', 'enable_initial_sync']).default('manual'),
  repoFullName: z.string().min(1).optional(),
});

const DependabotDismissReasonSchema = z.enum([
  'fix_started',
  'no_bandwidth',
  'tolerable_risk',
  'inaccurate',
  'not_used',
]);

const ManualFindingDismissalCommandSchema = z.object({
  schemaVersion: z.literal(1),
  owner: SecuritySyncOwnerSchema,
  actor: SecuritySyncActorSchema,
  findingId: z.string().uuid(),
  installationId: z.string().min(1),
  reason: DependabotDismissReasonSchema,
  comment: z.string().optional(),
});

const SecurityDismissMessageSchema = ManualFindingDismissalCommandSchema.extend({
  kind: z.literal('dismiss'),
  commandId: z.string().uuid(),
  runId: z.string().uuid(),
  messageId: z.string().min(1),
  dispatchedAt: z.string().datetime(),
});

export type SecuritySyncMessage = z.infer<typeof SecuritySyncMessageSchema>;
export type SecurityDismissMessage = z.infer<typeof SecurityDismissMessageSchema>;
export type SecuritySyncQueueMessage = SecuritySyncMessage | SecurityDismissMessage;

type OwnerEntry = {
  owner: { organizationId?: string; userId?: string };
  ownerKey: string;
};

type ScheduledSyncOwnerRow = {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  config: unknown;
};

const ScheduledSecurityAgentConfigSchema = z
  .object({
    auto_sync_enabled: z.boolean().default(true),
  })
  .passthrough();

function isScheduledSyncEnabled(config: unknown): boolean {
  const parsed = ScheduledSecurityAgentConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    console.warn('Invalid scheduled security agent config, skipping owner', {
      error: parsed.error.message,
    });
    return false;
  }

  return parsed.data.auto_sync_enabled;
}

export function collectScheduledSyncOwners(rows: ScheduledSyncOwnerRow[]): OwnerEntry[] {
  const deduplicated = new Map<string, OwnerEntry>();

  for (const row of rows) {
    if (!isScheduledSyncEnabled(row.config)) continue;

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

  return [...deduplicated.values()];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const QUEUE_SEND_BATCH_LIMIT = 100;

function createOwnerKey(owner: SecuritySyncMessage['owner']): string {
  if (owner.organizationId) return `org:${owner.organizationId}`;
  if (owner.userId) return `user:${owner.userId}`;
  throw new Error('owner.organizationId or owner.userId is required');
}

function toCommandOwner(owner: SecuritySyncMessage['owner']): SecurityAgentCommandOwner {
  if (owner.organizationId) return { type: 'org', id: owner.organizationId };
  if (owner.userId) return { type: 'user', id: owner.userId };
  throw new Error('owner.organizationId or owner.userId is required');
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  return nodeTimingSafeEqual(new Uint8Array(leftDigest), new Uint8Array(rightDigest));
}

async function enqueueManualSyncCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  command: z.infer<typeof ManualSecuritySyncCommandSchema>
): Promise<{ commandId: string; runId: string; messageId: string }> {
  const runId = crypto.randomUUID();
  const ownerKey = createOwnerKey(command.owner);
  const messageId = `${runId}:${ownerKey}:manual`;
  const ledgerCommand = await createSecurityAgentCommand(db, {
    commandType: 'sync',
    origin: command.origin,
    owner: toCommandOwner(command.owner),
    repoFullName: command.repoFullName,
  });

  try {
    await queue.sendBatch([
      {
        body: {
          schemaVersion: 1,
          commandId: ledgerCommand.id,
          runId,
          messageId,
          trigger: 'manual',
          owner: command.owner,
          ownerKey,
          chunkIndex: 0,
          chunkCount: 1,
          dispatchedAt: new Date().toISOString(),
          actor: command.actor,
          repoFullName: command.repoFullName,
        },
        contentType: 'json',
      },
    ]);
  } catch (error) {
    await markSecurityAgentCommandQueueAdmissionFailed(
      db,
      ledgerCommand.id,
      'Queue admission failed'
    );
    throw error;
  }

  return { commandId: ledgerCommand.id, runId, messageId };
}

async function enqueueDismissFindingCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  command: z.infer<typeof ManualFindingDismissalCommandSchema>
): Promise<{ commandId: string; runId: string; messageId: string }> {
  const runId = crypto.randomUUID();
  const messageId = `${runId}:${command.findingId}:dismiss`;
  const ledgerCommand = await createSecurityAgentCommand(db, {
    commandType: 'dismiss_finding',
    origin: 'manual',
    owner: toCommandOwner(command.owner),
    findingId: command.findingId,
  });

  try {
    await queue.sendBatch([
      {
        body: {
          ...command,
          kind: 'dismiss',
          commandId: ledgerCommand.id,
          runId,
          messageId,
          dispatchedAt: new Date().toISOString(),
        },
        contentType: 'json',
      },
    ]);
  } catch (error) {
    await markSecurityAgentCommandQueueAdmissionFailed(
      db,
      ledgerCommand.id,
      'Queue admission failed'
    );
    throw error;
  }

  return { commandId: ledgerCommand.id, runId, messageId };
}

async function enqueueOwners(
  queue: Queue<SecuritySyncQueueMessage>,
  runId: string,
  dispatchedAt: string,
  owners: OwnerEntry[]
): Promise<number> {
  if (owners.length === 0) return 0;

  const messages: MessageSendRequest<SecuritySyncQueueMessage>[] = owners.map(
    ({ owner, ownerKey }) => ({
      body: {
        schemaVersion: 1,
        runId,
        messageId: `${runId}:${ownerKey}:0`,
        trigger: 'scheduled',
        owner,
        ownerKey,
        chunkIndex: 0,
        chunkCount: 1,
        dispatchedAt,
      },
      contentType: 'json',
    })
  );

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

function syncCommandTerminalState(result: Awaited<ReturnType<typeof syncOwner>>): {
  status: 'succeeded' | 'failed' | 'no_op';
  resultCode: string;
} {
  if (result.commandResultCode === 'CONFIG_DISABLED') {
    return { status: 'no_op', resultCode: 'CONFIG_DISABLED' };
  }
  if (result.commandResultCode === 'REPOSITORY_UNAVAILABLE' || result.staleRepos.length > 0) {
    return { status: 'failed', resultCode: 'REPOSITORY_UNAVAILABLE' };
  }
  if (result.reauthRequired || result.authInvalid > 0) {
    return { status: 'failed', resultCode: 'GITHUB_AUTH_INVALID' };
  }
  if (result.errors > 0) {
    return { status: 'failed', resultCode: 'SYNC_PARTIAL_FAILURE' };
  }
  return { status: 'succeeded', resultCode: 'SYNC_COMPLETED' };
}

async function processSecurityDismissMessage(
  message: Message<SecuritySyncQueueMessage>,
  env: CloudflareEnv
): Promise<boolean> {
  const parsed = SecurityDismissMessageSchema.safeParse(message.body);
  if (!parsed.success) return false;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  await transitionSecurityAgentCommand(db, {
    commandId: parsed.data.commandId,
    fromStatuses: ['accepted', 'running'],
    status: 'running',
  });
  const result = await processSecurityFindingDismissal({
    db,
    gitTokenService: env.GIT_TOKEN_SERVICE,
    message: parsed.data,
  });
  await transitionSecurityAgentCommand(db, {
    commandId: parsed.data.commandId,
    fromStatuses: ['accepted', 'running'],
    status: result.commandStatus,
    resultCode: result.resultCode,
  });
  console.info('Security Agent dismissal command completed', {
    command_id: parsed.data.commandId,
    command_type: 'dismiss_finding',
    owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
    result_code: result.resultCode,
  });
  message.ack();
  return true;
}

async function processSecuritySyncMessage(
  message: Message<SecuritySyncQueueMessage>,
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
  if (body.commandId) {
    await transitionSecurityAgentCommand(db, {
      commandId: body.commandId,
      fromStatuses: ['accepted', 'running'],
      status: 'running',
    });
  }

  const result = await syncOwner({
    db,
    gitTokenService: env.GIT_TOKEN_SERVICE,
    owner,
    runId: body.runId,
    trigger: body.trigger,
    actor: body.actor,
    repoFullName: body.repoFullName,
  });

  const terminal = syncCommandTerminalState(result);
  if (body.commandId) {
    await transitionSecurityAgentCommand(db, {
      commandId: body.commandId,
      fromStatuses: ['accepted', 'running'],
      status: terminal.status,
      resultCode: terminal.resultCode,
    });
  }
  console.info('Security sync completed for owner', {
    command_id: body.commandId,
    command_type: body.commandId ? 'sync' : undefined,
    result_code: body.commandId ? terminal.resultCode : undefined,
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
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'cloudflare-security-sync',
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === 'POST' && url.pathname === '/internal/manual-sync') {
      if (env.MANUAL_SYNC_COMMAND_ROUTING_ENABLED === 'false') {
        return jsonResponse(
          { success: false, error: 'Manual sync Worker routing is disabled' },
          503
        );
      }
      const [internalSecret, authHeader] = await Promise.all([
        env.INTERNAL_API_SECRET.get(),
        Promise.resolve(request.headers.get('x-internal-api-key')),
      ]);

      if (!authHeader || !internalSecret || !(await timingSafeEqual(authHeader, internalSecret))) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
      }

      const parsed = ManualSecuritySyncCommandSchema.safeParse(payload);
      if (!parsed.success) {
        return jsonResponse(
          { success: false, error: 'Invalid manual sync command', issues: parsed.error.issues },
          400
        );
      }

      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
      const accepted = await enqueueManualSyncCommand(db, env.SYNC_QUEUE, parsed.data);
      return jsonResponse({ success: true, accepted: true, ...accepted }, 202);
    }

    if (request.method === 'POST' && url.pathname === '/internal/dismiss-finding') {
      if (env.DISMISS_FINDING_COMMAND_ROUTING_ENABLED === 'false') {
        return jsonResponse(
          { success: false, error: 'Finding dismissal Worker routing is disabled' },
          503
        );
      }
      const [internalSecret, authHeader] = await Promise.all([
        env.INTERNAL_API_SECRET.get(),
        Promise.resolve(request.headers.get('x-internal-api-key')),
      ]);

      if (!authHeader || !internalSecret || !(await timingSafeEqual(authHeader, internalSecret))) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
      }

      const parsed = ManualFindingDismissalCommandSchema.safeParse(payload);
      if (!parsed.success) {
        return jsonResponse(
          {
            success: false,
            error: 'Invalid finding dismissal command',
            issues: parsed.error.issues,
          },
          400
        );
      }

      const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
      const accepted = await enqueueDismissFindingCommand(db, env.SYNC_QUEUE, parsed.data);
      return jsonResponse({ success: true, accepted: true, ...accepted }, 202);
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
          config: agent_configs.config,
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

      const owners = collectScheduledSyncOwners(rows);
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

  async queue(batch: MessageBatch<SecuritySyncQueueMessage>, env: CloudflareEnv): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (await processSecurityDismissMessage(message, env)) {
          continue;
        }
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
