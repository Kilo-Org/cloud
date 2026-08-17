import { timingSafeEqual as nodeTimingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  createOrFindSecurityAgentCommandByOperationKey,
  createSecurityAgentCommand,
  isTerminalSecurityAgentCommandTransitionOutcome,
  markSecurityAgentCommandQueueAdmissionFailed,
  markSecurityAgentCommandRetriesExhausted,
  requireSecurityAgentCommandTransitionOrTerminal,
  transitionSecurityAgentCommandWithCurrentState,
  type CreateSecurityAgentCommandInput,
  type SecurityAgentCommand,
  type SecurityAgentCommandOwner,
  type SecurityAgentCommandTransitionOutcome,
} from '@kilocode/db';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { agent_configs, operation_ledgers } from '@kilocode/db/schema';
import { settleOperation } from '@kilocode/db/operation-ledger';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { eq, and, isNotNull, or } from 'drizzle-orm';
import { syncOwner } from './sync';
import { processSecurityFindingDismissal } from './dismiss';
import { runSecurityNotificationSweep } from './notifications/sweep';

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
  /** Stable web operation key (P1-A-08e); same-key retries reuse the original command. */
  operationKey: z.string().min(1).max(128).optional(),
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
  /** Stable web operation key (P1-A-08e); same-key retries reuse the original command. */
  operationKey: z.string().min(1).max(128).optional(),
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

function isStrictTrueRolloutFlag(value: string | undefined, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false' || value === undefined) return false;
  console.warn('Malformed Security Sync rollout flag; treating as disabled', { name });
  return false;
}

function getEnvironment(env: CloudflareEnv): string | undefined {
  if ('ENVIRONMENT' in env && typeof env.ENVIRONMENT === 'string') {
    return env.ENVIRONMENT;
  }
  return undefined;
}

const QUEUE_SEND_BATCH_LIMIT = 100;
const SECURITY_SYNC_COMMAND_MAX_ATTEMPTS = 4;

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

// ----- same-key command dedupe (P1-A-08e) ------------------------------------
//
// A command carrying the web's stable `operationKey` is created-or-found by
// that key on `security_agent_commands`, whose partial unique index on
// (owner, operation_key) arbitrates the race. A same-key request resolves to
// the existing command and sends no second queue message, so the effect runs
// once. Scheduled syncs and keyless commands carry no key and always create.

type KeyedEnqueueIds = { commandId: string; runId: string; messageId: string };

function buildManualSyncQueueMessage(
  command: z.infer<typeof ManualSecuritySyncCommandSchema>,
  ids: KeyedEnqueueIds,
  ownerKey: string
): MessageSendRequest<SecuritySyncQueueMessage> {
  return {
    body: {
      schemaVersion: 1,
      commandId: ids.commandId,
      runId: ids.runId,
      messageId: ids.messageId,
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
  };
}

function buildDismissQueueMessage(
  command: z.infer<typeof ManualFindingDismissalCommandSchema>,
  ids: KeyedEnqueueIds
): MessageSendRequest<SecuritySyncQueueMessage> {
  return {
    body: {
      ...command,
      kind: 'dismiss',
      commandId: ids.commandId,
      runId: ids.runId,
      messageId: ids.messageId,
      dispatchedAt: new Date().toISOString(),
    },
    contentType: 'json',
  };
}

/**
 * Creates the command row and sends its queue message. With an `operationKey`
 * the row is created-or-found by that key (P1-A-08e): a same-key retry returns
 * the original command. A command whose first queue admission failed is reset
 * and enqueued again; every other existing command sends no second message.
 * A queue-send failure marks the command failed before rethrowing, so no
 * command is left waiting for a message that was never sent.
 */
async function enqueueSecurityCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  params: {
    operationKey?: string;
    create: CreateSecurityAgentCommandInput;
    runId: string;
    messageId: string;
    buildMessage: (ids: KeyedEnqueueIds) => MessageSendRequest<SecuritySyncQueueMessage>;
  }
): Promise<KeyedEnqueueIds> {
  const { command, created } =
    params.operationKey === undefined
      ? { command: await createSecurityAgentCommand(db, params.create), created: true }
      : await createOrFindSecurityAgentCommandByOperationKey(db, {
          ...params.create,
          operationKey: params.operationKey,
        });

  const ids = { commandId: command.id, runId: params.runId, messageId: params.messageId };

  let shouldEnqueue = created;
  if (!created && command.status === 'failed' && command.result_code === 'QUEUE_ADMISSION_FAILED') {
    const retry = await transitionSecurityAgentCommandWithCurrentState(db, {
      commandId: command.id,
      fromStatuses: ['failed'],
      status: 'accepted',
      resultCode: null,
      lastErrorRedacted: null,
    });
    shouldEnqueue = retry.transitioned;
  }

  if (!shouldEnqueue) {
    console.info('Security command reused for an existing operation key', {
      command_type: params.create.commandType,
      operation_key: params.operationKey,
      command_id: command.id,
    });
    return ids;
  }

  try {
    await queue.sendBatch([params.buildMessage(ids)]);
  } catch (error) {
    await markSecurityAgentCommandQueueAdmissionFailed(db, command.id, 'Queue admission failed');
    throw error;
  }

  return ids;
}

async function enqueueManualSyncCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  command: z.infer<typeof ManualSecuritySyncCommandSchema>
): Promise<KeyedEnqueueIds> {
  const runId = crypto.randomUUID();
  const ownerKey = createOwnerKey(command.owner);

  return enqueueSecurityCommand(db, queue, {
    operationKey: command.operationKey,
    create: {
      commandType: 'sync',
      origin: command.origin,
      owner: toCommandOwner(command.owner),
      repoFullName: command.repoFullName,
    },
    runId,
    messageId: `${runId}:${ownerKey}:manual`,
    buildMessage: ids => buildManualSyncQueueMessage(command, ids, ownerKey),
  });
}

async function enqueueDismissFindingCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  command: z.infer<typeof ManualFindingDismissalCommandSchema>
): Promise<KeyedEnqueueIds> {
  const runId = crypto.randomUUID();

  return enqueueSecurityCommand(db, queue, {
    operationKey: command.operationKey,
    create: {
      commandType: 'dismiss_finding',
      origin: 'manual',
      owner: toCommandOwner(command.owner),
      findingId: command.findingId,
    },
    runId,
    messageId: `${runId}:${command.findingId}:dismiss`,
    buildMessage: ids => buildDismissQueueMessage(command, ids),
  });
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

function resolveOwner(
  raw: SecuritySyncMessage['owner']
): { organizationId: string } | { userId: string } | null {
  if (raw.organizationId) return { organizationId: raw.organizationId };
  if (raw.userId) return { userId: raw.userId };
  return null;
}

type CommandCorrelation = {
  commandId?: string;
  commandType?: 'sync' | 'dismiss_finding';
  ownerType?: 'org' | 'user';
  ledger?: {
    actor: { id: string; email?: string | null };
    intent: 'manual_sync' | 'dismiss_finding';
    dispatchedAt: string;
  };
};

function commandCorrelation(body: unknown): CommandCorrelation {
  const dismiss = SecurityDismissMessageSchema.safeParse(body);
  if (dismiss.success) {
    return {
      commandId: dismiss.data.commandId,
      commandType: 'dismiss_finding',
      ownerType: dismiss.data.owner.organizationId ? 'org' : 'user',
      ledger: {
        actor: dismiss.data.actor,
        intent: 'dismiss_finding',
        dispatchedAt: dismiss.data.dispatchedAt,
      },
    };
  }
  const sync = SecuritySyncMessageSchema.safeParse(body);
  if (!sync.success || !sync.data.commandId) return {};
  const correlation: CommandCorrelation = {
    commandId: sync.data.commandId,
    commandType: 'sync',
    ownerType: sync.data.owner.organizationId ? 'org' : 'user',
  };
  if (sync.data.trigger === 'manual' && sync.data.actor) {
    correlation.ledger = {
      actor: sync.data.actor,
      intent: 'manual_sync',
      dispatchedAt: sync.data.dispatchedAt,
    };
  }
  return correlation;
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

function securityLedgerTerminalStatus(status: SecurityAgentCommand['status']) {
  switch (status) {
    case 'succeeded':
      return 'completed' as const;
    case 'failed':
      return 'failed' as const;
    case 'no_op':
      return 'no_op' as const;
    default:
      return null;
  }
}

async function settleSecurityLedgerForTerminalCommand(
  db: WorkerDb,
  command: SecurityAgentCommand | null,
  params: {
    actor: { id: string; email?: string | null };
    intent: 'manual_sync' | 'dismiss_finding';
    dispatchedAt: string;
    counts?: { repo_count: number; error_count: number };
  }
): Promise<void> {
  if (!command) throw new Error('Security Agent terminal transition has no command');
  if (!command.operation_key) return;

  const status = securityLedgerTerminalStatus(command.status);
  if (!status) throw new Error(`Security Agent command ${command.id} is not terminal`);

  const [row] = await db
    .select({ id: operation_ledgers.id })
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.domain, 'security'),
        eq(operation_ledgers.kilo_user_id, params.actor.id),
        eq(operation_ledgers.intent, params.intent),
        eq(operation_ledgers.provider_ref, command.id)
      )
    )
    .limit(1);
  if (!row) {
    throw new Error(`Security operation ledger row is not ready for command ${command.id}`);
  }

  const settled = await settleOperation(db, {
    rowId: row.id,
    status,
    outcomeCode: command.result_code,
    canonicalResult: params.counts,
    outboxEvent: {
      eventName: 'security_command_settled',
      distinctId: params.actor.email ?? params.actor.id,
      properties: {
        source: 'server',
        surface: 'security',
        phase: 'terminal',
        intent: params.intent,
        outcome: status,
        ...params.counts,
        duration_ms: Math.max(0, Date.now() - new Date(params.dispatchedAt).getTime()),
      },
    },
  });
  if (!settled.row) {
    throw new Error(`Security operation ledger row vanished for command ${command.id}`);
  }
}

async function processSecurityDismissMessage(
  message: Message<SecuritySyncQueueMessage>,
  env: CloudflareEnv
): Promise<boolean> {
  const parsed = SecurityDismissMessageSchema.safeParse(message.body);
  if (!parsed.success) return false;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  const running = await transitionSecurityAgentCommandWithCurrentState(db, {
    commandId: parsed.data.commandId,
    fromStatuses: ['accepted', 'running'],
    status: 'running',
  });
  if (requireSecurityAgentCommandTransitionOrTerminal(running, 'running') === 'terminal') {
    console.info('Security Agent dismissal command delivery already terminal', {
      command_id: parsed.data.commandId,
      command_type: 'dismiss_finding',
      owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
      result_code: running.command?.result_code,
      attempts: message.attempts,
    });
    await settleSecurityLedgerForTerminalCommand(db, running.command, {
      actor: parsed.data.actor,
      intent: 'dismiss_finding',
      dispatchedAt: parsed.data.dispatchedAt,
    });
    message.ack();
    return true;
  }
  const result = await processSecurityFindingDismissal({
    db,
    gitTokenService: env.GIT_TOKEN_SERVICE,
    message: parsed.data,
  });
  const terminal = await transitionSecurityAgentCommandWithCurrentState(db, {
    commandId: parsed.data.commandId,
    fromStatuses: ['running'],
    status: result.commandStatus,
    resultCode: result.resultCode,
  });
  requireSecurityAgentCommandTransitionOrTerminal(terminal, 'terminal');
  await settleSecurityLedgerForTerminalCommand(db, terminal.command, {
    actor: parsed.data.actor,
    intent: 'dismiss_finding',
    dispatchedAt: parsed.data.dispatchedAt,
  });
  console.info('Security Agent dismissal command completed', {
    command_id: parsed.data.commandId,
    command_type: 'dismiss_finding',
    owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
    result_code: result.resultCode,
    attempts: message.attempts,
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
    const running = await transitionSecurityAgentCommandWithCurrentState(db, {
      commandId: body.commandId,
      fromStatuses: ['accepted', 'running'],
      status: 'running',
    });
    if (requireSecurityAgentCommandTransitionOrTerminal(running, 'running') === 'terminal') {
      console.info('Security sync command delivery already terminal', {
        command_id: body.commandId,
        command_type: 'sync',
        owner_type: body.owner.organizationId ? 'org' : 'user',
        result_code: running.command?.result_code,
        attempts: message.attempts,
      });
      if (!body.actor) throw new Error('Manual security sync command has no actor');
      await settleSecurityLedgerForTerminalCommand(db, running.command, {
        actor: body.actor,
        intent: 'manual_sync',
        dispatchedAt: body.dispatchedAt,
      });
      message.ack();
      return;
    }
  }

  const result = await syncOwner({
    db,
    gitTokenService: env.GIT_TOKEN_SERVICE,
    owner,
    runId: body.runId,
    trigger: body.trigger,
    actor: body.actor,
    repoFullName: body.repoFullName,
    notificationMaterializationEnabled: isStrictTrueRolloutFlag(
      env.SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED,
      'SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED'
    ),
  });

  const terminal = syncCommandTerminalState(result);
  if (body.commandId) {
    const terminalTransition = await transitionSecurityAgentCommandWithCurrentState(db, {
      commandId: body.commandId,
      fromStatuses: ['running'],
      status: terminal.status,
      resultCode: terminal.resultCode,
    });
    requireSecurityAgentCommandTransitionOrTerminal(terminalTransition, 'terminal');
    if (!body.actor) throw new Error('Manual security sync command has no actor');
    await settleSecurityLedgerForTerminalCommand(db, terminalTransition.command, {
      actor: body.actor,
      intent: 'manual_sync',
      dispatchedAt: body.dispatchedAt,
      counts: { repo_count: result.synced, error_count: result.errors },
    });
  }
  console.info('Security sync completed for owner', {
    command_id: body.commandId,
    command_type: body.commandId ? 'sync' : undefined,
    owner_type: body.commandId ? (body.owner.organizationId ? 'org' : 'user') : undefined,
    result_code: body.commandId ? terminal.resultCode : undefined,
    attempts: message.attempts,
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

  async scheduled(controller: ScheduledController, env: CloudflareEnv) {
    const environment = getEnvironment(env);
    if (controller.cron === '15 * * * *') {
      const run = createScheduledJobRun({
        jobName: 'security_sync.notification_sweep',
        environment,
      });
      try {
        const result = await runSecurityNotificationSweep(env);
        emitScheduledJobEvent(
          buildScheduledJobSuccessEvent(run, {
            scheduled_time: controller.scheduledTime,
            schedule: controller.cron,
            recovered: result.recovered,
            staged_recovered: result.stagedRecovered,
            cancelled: result.cancelled,
            materialized: result.materialized,
            reactivated: result.reactivated,
            processed: result.processed,
            sent: result.sent,
            retried: result.retried,
            failed: result.failed,
            deferred: result.deferred,
            dispatch_cap_reached: result.dispatchCapReached,
            materialization_cap_reached: result.materializationCapReached,
          })
        );
      } catch (error) {
        emitScheduledJobEvent({
          ...buildScheduledJobFailureEvent(run, error),
          scheduled_time: controller.scheduledTime,
          schedule: controller.cron,
        });
        throw error;
      }
      return;
    }
    if (controller.cron !== '0 */6 * * *') {
      console.info('Ignoring unknown Security Sync cron expression', { cron: controller.cron });
      return;
    }

    const runId = crypto.randomUUID();
    const run = createScheduledJobRun({
      jobName: 'security_sync.dispatch',
      runId,
      environment,
    });

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
      emitScheduledJobEvent(
        buildScheduledJobSuccessEvent(run, {
          scheduled_time: controller.scheduledTime,
          schedule: controller.cron,
          owner_count: owners.length,
          enqueued_message_count: enqueuedMessages,
        })
      );
    } catch (error) {
      console.error('Security sync scheduled dispatch failed', {
        runId,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
      emitScheduledJobEvent({
        ...buildScheduledJobFailureEvent(run, error),
        scheduled_time: controller.scheduledTime,
        schedule: controller.cron,
      });
      throw error;
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
        const correlation = commandCorrelation(message.body);
        let exhaustionOutcome: SecurityAgentCommandTransitionOutcome | undefined;
        if (correlation.commandId && message.attempts >= SECURITY_SYNC_COMMAND_MAX_ATTEMPTS) {
          try {
            const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
            exhaustionOutcome = await markSecurityAgentCommandRetriesExhausted(
              db,
              correlation.commandId
            );
            if (exhaustionOutcome.command && correlation.ledger) {
              await settleSecurityLedgerForTerminalCommand(
                db,
                exhaustionOutcome.command,
                correlation.ledger
              );
            }
            if (isTerminalSecurityAgentCommandTransitionOutcome(exhaustionOutcome)) {
              console.info('Security Agent command delivery already terminal after failure', {
                command_id: correlation.commandId,
                command_type: correlation.commandType,
                owner_type: correlation.ownerType,
                result_code: exhaustionOutcome.command?.result_code,
                attempts: message.attempts,
              });
              message.ack();
              continue;
            }
          } catch (transitionError) {
            console.error('Failed to record exhausted Security Agent command', {
              command_id: correlation.commandId,
              command_type: correlation.commandType,
              owner_type: correlation.ownerType,
              attempts: message.attempts,
              error_type: transitionError instanceof Error ? transitionError.name : 'UnknownError',
            });
          }
        }
        console.error('Security sync queue processing failed', {
          command_id: correlation.commandId,
          command_type: correlation.commandType,
          owner_type: correlation.ownerType,
          attempts: message.attempts,
          result_code: exhaustionOutcome?.transitioned ? 'QUEUE_RETRIES_EXHAUSTED' : undefined,
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
        message.retry();
      }
    }
  },
};
