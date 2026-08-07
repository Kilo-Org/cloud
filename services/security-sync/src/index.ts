import { timingSafeEqual as nodeTimingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  createSecurityAgentCommand,
  isTerminalSecurityAgentCommandTransitionOutcome,
  markSecurityAgentCommandQueueAdmissionFailed,
  markSecurityAgentCommandRetriesExhausted,
  requireSecurityAgentCommandTransitionOrTerminal,
  transitionSecurityAgentCommandWithCurrentState,
  type SecurityAgentCommandOwner,
  type SecurityAgentCommandTransitionOutcome,
} from '@kilocode/db';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { agent_configs, kilocode_users, operation_ledgers } from '@kilocode/db/schema';
import {
  recordOperationAcceptance,
  recordOperationProgress,
  settleOperation,
  type LedgerTransaction,
} from '@kilocode/db/operation-ledger';
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

const SecuritySyncActorIdSchema = z.object({
  id: z.string().min(1),
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
  actor: SecuritySyncActorIdSchema,
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

// ----- security operation ledger dedupe (P1-A-08e) ---------------------------
//
// Manual sync and dismissal commands carry the web's stable `operationKey`.
// The web admits a `security`-domain ledger row BEFORE calling the Worker, so
// at enqueue time a keyed request locks the matching row with `FOR UPDATE` and
// either reuses the already-recorded acceptance (no second command, run,
// message, or queued effect) or creates the command and records `provider_ref`
// plus `canonical_result` in the SAME transaction. A missing ledger row or a
// failed acceptance update fails the request before any command or queue
// effect. The queue batch is sent only after that transaction commits, so
// acceptance always precedes queue send. Every post-acceptance ledger write is
// fenced on the `queueSendClaimId` recorded at acceptance: a stale sender whose
// claim was superseded cannot clear or confirm a newer claim. A queue-send
// failure releases the sender's claim (keeping `queueAdmitted: false`) so a
// same-key retry re-claims and re-sends the original command and message
// instead of creating a second one, and the queue error is reported only after
// that release commits. Scheduled syncs and keyless commands never touch this
// path.

const SECURITY_LEDGER_DOMAIN = 'security';
const QUEUE_SEND_LEASE_MS = 60_000;

type SecurityLedgerLookupRow = {
  id: string;
  intent: string;
  status: string;
  provider_ref: string | null;
  canonical_result: Record<string, unknown> | null;
};

type SecurityLedgerAcceptance = {
  commandId: string;
  runId: string;
  messageId: string;
  queueAdmitted: boolean;
  queueSendClaimedUntil?: string;
  queueSendClaimId?: string;
};

/**
 * Locks the security ledger row admitted for a stable operation key inside the
 * caller's transaction. The `FOR UPDATE` lock serializes concurrent same-key
 * requests: the first enqueuer commits its acceptance, then a blocked requester
 * re-reads the row and reuses that acceptance instead of creating a second
 * command, run, message, or queued effect.
 */
async function lockSecurityLedgerRow(
  tx: LedgerTransaction,
  params: { operationKey: string; userId: string }
): Promise<SecurityLedgerLookupRow | null> {
  const rows = await tx
    .select({
      id: operation_ledgers.id,
      intent: operation_ledgers.intent,
      status: operation_ledgers.status,
      provider_ref: operation_ledgers.provider_ref,
      canonical_result: operation_ledgers.canonical_result,
    })
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.domain, SECURITY_LEDGER_DOMAIN),
        eq(operation_ledgers.operation_key, params.operationKey),
        eq(operation_ledgers.kilo_user_id, params.userId)
      )
    )
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Extracts the recorded Worker acceptance from a ledger row when the matching
 * intent already accepted a command. The `provider_ref` plus the replay-safe
 * `canonical_result` carry the original command identifiers.
 */
function securityLedgerAcceptanceFromRow(
  row: SecurityLedgerLookupRow,
  intent: 'manual_sync' | 'dismiss_finding'
): SecurityLedgerAcceptance | null {
  if (row.intent !== intent || !row.provider_ref || !row.canonical_result) {
    return null;
  }
  const canonical = row.canonical_result;
  if (
    typeof canonical.commandId === 'string' &&
    typeof canonical.runId === 'string' &&
    typeof canonical.messageId === 'string'
  ) {
    return {
      commandId: canonical.commandId,
      runId: canonical.runId,
      messageId: canonical.messageId,
      queueAdmitted:
        canonical.queueAdmitted === true ||
        ['completed', 'failed', 'no_op', 'interrupted', 'superseded'].includes(row.status),
      queueSendClaimedUntil:
        typeof canonical.queueSendClaimedUntil === 'string'
          ? canonical.queueSendClaimedUntil
          : undefined,
      queueSendClaimId:
        typeof canonical.queueSendClaimId === 'string' ? canonical.queueSendClaimId : undefined,
    };
  }
  return null;
}

type KeyedEnqueueIds = { commandId: string; runId: string; messageId: string };

type KeyedLedgerAdmission =
  | { reused: true; ids: KeyedEnqueueIds }
  | { reused: false; ids: KeyedEnqueueIds; rowId: string; queueSendClaimId: string };

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
 * Transaction-safe enqueue for a keyed command (P1-A-08e). A keyed request
 * requires the ledger row the web admitted before calling the Worker: a
 * missing row or a failed acceptance update fails the request without creating
 * a command, sending a queue message, or returning 202. The matching ledger row
 * is locked with `FOR UPDATE`; a row that already carries a complete acceptance
 * reuses the original identifiers, and otherwise the command is created and the
 * acceptance (`provider_ref` + `canonical_result`) is recorded in the SAME
 * transaction. The queue send claim is committed before the queue send. A
 * retry reuses the command and message identity until queue admission is
 * confirmed, then command processing deduplicates any crash-window replay.
 */
async function enqueueKeyedSecurityCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  params: {
    operationKey: string;
    userId: string;
    intent: 'manual_sync' | 'dismiss_finding';
    runId: string;
    messageId: string;
    description: string;
    createCommand: (tx: LedgerTransaction) => Promise<{ id: string }>;
    buildMessage: (ids: KeyedEnqueueIds) => MessageSendRequest<SecuritySyncQueueMessage>;
  }
): Promise<KeyedEnqueueIds> {
  const admission: KeyedLedgerAdmission = await db.transaction(async tx => {
    const row = await lockSecurityLedgerRow(tx, {
      operationKey: params.operationKey,
      userId: params.userId,
    });
    if (!row) {
      throw new Error(
        `Security operation ledger row not found for operation key ${params.operationKey}`
      );
    }
    if (row.intent !== params.intent) {
      throw new Error(
        `Security operation ledger intent mismatch for operation key ${params.operationKey}`
      );
    }
    const reused = securityLedgerAcceptanceFromRow(row, params.intent);
    const queueSendClaimedUntil = reused?.queueSendClaimedUntil
      ? Date.parse(reused.queueSendClaimedUntil)
      : Number.NaN;
    if (
      reused?.queueAdmitted ||
      (Number.isFinite(queueSendClaimedUntil) && queueSendClaimedUntil > Date.now())
    ) {
      if (!reused) throw new Error('Security operation ledger acceptance is missing');
      return {
        reused: true,
        ids: {
          commandId: reused.commandId,
          runId: reused.runId,
          messageId: reused.messageId,
        },
      };
    }
    const nextQueueSendClaimedUntil = new Date(Date.now() + QUEUE_SEND_LEASE_MS).toISOString();
    const queueSendClaimId = crypto.randomUUID();
    const ids = reused ?? {
      commandId: (await params.createCommand(tx)).id,
      runId: params.runId,
      messageId: params.messageId,
    };
    if (!reused) {
      const updated = await recordOperationAcceptance(tx, {
        rowId: row.id,
        providerRef: ids.messageId,
        canonicalResult: {
          commandId: ids.commandId,
          runId: ids.runId,
          messageId: ids.messageId,
          queueAdmitted: false,
          queueSendClaimedUntil: nextQueueSendClaimedUntil,
          queueSendClaimId,
        },
      });
      if (!updated) {
        throw new Error(
          `Security operation ledger acceptance was not recorded for operation key ${params.operationKey}`
        );
      }
    } else {
      const claimed = await recordOperationProgress(
        tx,
        row.id,
        {
          queueAdmitted: false,
          queueSendClaimedUntil: nextQueueSendClaimedUntil,
          queueSendClaimId,
        },
        { expectedQueueSendClaimId: reused.queueSendClaimId }
      );
      if (!claimed) {
        throw new Error(
          `Security operation ledger queue claim was not recorded for operation key ${params.operationKey}`
        );
      }
    }
    return {
      reused: false,
      ids: {
        commandId: ids.commandId,
        runId: ids.runId,
        messageId: ids.messageId,
      },
      rowId: row.id,
      queueSendClaimId,
    };
  });

  if (admission.reused) {
    console.info(`${params.description} reused from operation ledger acceptance`, {
      operation_key: params.operationKey,
      command_id: admission.ids.commandId,
      run_id: admission.ids.runId,
      message_id: admission.ids.messageId,
    });
    return admission.ids;
  }

  try {
    await queue.sendBatch([params.buildMessage(admission.ids)]);
  } catch (error) {
    try {
      const released = await recordOperationProgress(
        db,
        admission.rowId,
        {
          queueAdmitted: false,
          queueSendClaimedUntil: new Date(0).toISOString(),
          queueSendClaimId: null,
        },
        { expectedQueueSendClaimId: admission.queueSendClaimId }
      );
      if (!released) {
        console.info('Security queue-send claim was replaced after queue failure', {
          operation_key: params.operationKey,
          row_id: admission.rowId,
        });
      }
    } catch (releaseError) {
      console.error('Failed to release security queue-send claim', {
        operation_key: params.operationKey,
        row_id: admission.rowId,
        error_type: releaseError instanceof Error ? releaseError.name : 'UnknownError',
      });
      throw new Error(
        'Security operation ledger queue claim could not be released after queue failure'
      );
    }
    throw error;
  }

  const queued = await recordOperationProgress(
    db,
    admission.rowId,
    {
      queueAdmitted: true,
      queueSendClaimedUntil: new Date(0).toISOString(),
      queueSendClaimId: null,
    },
    { expectedQueueSendClaimId: admission.queueSendClaimId }
  );
  if (!queued) {
    console.info('Security queue-send claim was replaced after queue success', {
      operation_key: params.operationKey,
      row_id: admission.rowId,
    });
  }
  return admission.ids;
}

async function enqueueManualSyncCommand(
  db: WorkerDb,
  queue: Queue<SecuritySyncQueueMessage>,
  command: z.infer<typeof ManualSecuritySyncCommandSchema>
): Promise<KeyedEnqueueIds> {
  const runId = crypto.randomUUID();
  const ownerKey = createOwnerKey(command.owner);
  const messageId = `${runId}:${ownerKey}:manual`;

  if (command.operationKey !== undefined) {
    return enqueueKeyedSecurityCommand(db, queue, {
      operationKey: command.operationKey,
      userId: command.actor.id,
      intent: 'manual_sync',
      runId,
      messageId,
      description: 'Manual sync command',
      createCommand: tx =>
        createSecurityAgentCommand(tx, {
          commandType: 'sync',
          origin: command.origin,
          owner: toCommandOwner(command.owner),
          repoFullName: command.repoFullName,
        }),
      buildMessage: ids => buildManualSyncQueueMessage(command, ids, ownerKey),
    });
  }

  const ledgerCommand = await createSecurityAgentCommand(db, {
    commandType: 'sync',
    origin: command.origin,
    owner: toCommandOwner(command.owner),
    repoFullName: command.repoFullName,
  });

  try {
    await queue.sendBatch([
      buildManualSyncQueueMessage(
        command,
        { commandId: ledgerCommand.id, runId, messageId },
        ownerKey
      ),
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
): Promise<KeyedEnqueueIds> {
  const runId = crypto.randomUUID();
  const messageId = `${runId}:${command.findingId}:dismiss`;

  if (command.operationKey !== undefined) {
    return enqueueKeyedSecurityCommand(db, queue, {
      operationKey: command.operationKey,
      userId: command.actor.id,
      intent: 'dismiss_finding',
      runId,
      messageId,
      description: 'Finding dismissal command',
      createCommand: tx =>
        createSecurityAgentCommand(tx, {
          commandType: 'dismiss_finding',
          origin: 'manual',
          owner: toCommandOwner(command.owner),
          findingId: command.findingId,
        }),
      buildMessage: ids => buildDismissQueueMessage(command, ids),
    });
  }

  const ledgerCommand = await createSecurityAgentCommand(db, {
    commandType: 'dismiss_finding',
    origin: 'manual',
    owner: toCommandOwner(command.owner),
    findingId: command.findingId,
  });

  try {
    await queue.sendBatch([
      buildDismissQueueMessage(command, { commandId: ledgerCommand.id, runId, messageId }),
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

function resolveOwner(
  raw: SecuritySyncMessage['owner']
): { organizationId: string } | { userId: string } | null {
  if (raw.organizationId) return { organizationId: raw.organizationId };
  if (raw.userId) return { userId: raw.userId };
  return null;
}

function commandCorrelation(body: unknown): {
  commandId?: string;
  commandType?: 'sync' | 'dismiss_finding';
  ownerType?: 'org' | 'user';
} {
  const dismiss = SecurityDismissMessageSchema.safeParse(body);
  if (dismiss.success) {
    return {
      commandId: dismiss.data.commandId,
      commandType: 'dismiss_finding',
      ownerType: dismiss.data.owner.organizationId ? 'org' : 'user',
    };
  }
  const sync = SecuritySyncMessageSchema.safeParse(body);
  if (!sync.success || !sync.data.commandId) return {};
  return {
    commandId: sync.data.commandId,
    commandType: 'sync',
    ownerType: sync.data.owner.organizationId ? 'org' : 'user',
  };
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

// ----- security operation ledger join (P1-A-08e) ----------------------------
//
// Manual sync and dismissal commands admitted with an `operationKey` store the
// Worker `messageId` in `operation_ledgers.provider_ref` at acceptance. After
// the command reaches a terminal state, the Worker joins that row by provider
// reference and settles it with the security terminal mapping
// (succeeded→completed, failed→failed, no_op→no_op) plus a durable
// `security_command_settled` outbox event written atomically by
// `settleOperation`. Rows that are missing or already terminal are skipped:
// scheduled syncs and keyless commands have no ledger row, and a second settle
// of a terminal row is a no-op by ledger design.

const SECURITY_TERMINAL_STATUS_MAP = {
  succeeded: 'completed',
  failed: 'failed',
  no_op: 'no_op',
} as const;

function isTerminalSecurityLedgerStatus(
  status: string
): status is keyof typeof SECURITY_TERMINAL_STATUS_MAP {
  return status === 'succeeded' || status === 'failed' || status === 'no_op';
}

/** Resolves the analytics identity channel (user email) for the outbox event. */
async function resolveSecuritySettleDistinctId(
  db: WorkerDb,
  params: { userId?: string; email?: string | null }
): Promise<string> {
  if (params.email) return params.email;
  if (!params.userId) return 'unknown';
  try {
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.userId))
      .limit(1);
    return user?.email ?? params.userId;
  } catch (error) {
    console.error('Failed to resolve security settle distinct id', {
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
    return params.userId;
  }
}

/**
 * Settles the ledger row joined by `provider_ref = messageId`. Missing rows
 * skip (scheduled syncs and keyless commands have no ledger row, and a second
 * settle of a terminal row is a no-op by ledger design). A failed lookup or
 * settle re-throws so the caller leaves the queue message unacknowledged —
 * the message is retried instead of losing the terminal settlement.
 */
async function settleSecurityLedgerByProviderRef(
  db: WorkerDb,
  params: {
    providerRef: string;
    intent: 'manual_sync' | 'dismiss_finding';
    status: 'succeeded' | 'failed' | 'no_op';
    resultCode: string;
    userId?: string;
    actorEmail?: string | null;
    dispatchedAt: string;
    repoCount?: number;
    errorCount?: number;
  }
): Promise<void> {
  let row: { id: string } | undefined;
  try {
    const rows = await db
      .select({ id: operation_ledgers.id })
      .from(operation_ledgers)
      .where(eq(operation_ledgers.provider_ref, params.providerRef))
      .limit(1);
    row = rows[0];
  } catch (error) {
    console.error('Security operation ledger lookup failed', {
      provider_ref: params.providerRef,
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
  if (!row) {
    console.info('Security operation ledger row not found for provider ref; skipping settle', {
      provider_ref: params.providerRef,
      intent: params.intent,
      result_code: params.resultCode,
    });
    return;
  }

  const status = SECURITY_TERMINAL_STATUS_MAP[params.status];
  const dispatched = new Date(params.dispatchedAt).getTime();
  const durationMs = Number.isFinite(dispatched) ? Math.max(0, Date.now() - dispatched) : 0;
  const distinctId = await resolveSecuritySettleDistinctId(db, {
    userId: params.userId,
    email: params.actorEmail,
  });

  try {
    await settleOperation(db, {
      rowId: row.id,
      status,
      outcomeCode: params.resultCode,
      canonicalResult: {
        ...(params.repoCount !== undefined ? { repo_count: params.repoCount } : {}),
        ...(params.errorCount !== undefined ? { error_count: params.errorCount } : {}),
      },
      outboxEvent: {
        eventName: 'security_command_settled',
        distinctId,
        properties: {
          source: 'server',
          surface: 'security',
          phase: 'terminal',
          intent: params.intent,
          outcome: status,
          ...(params.repoCount !== undefined ? { repo_count: params.repoCount } : {}),
          ...(params.errorCount !== undefined ? { error_count: params.errorCount } : {}),
          duration_ms: durationMs,
        },
      },
    });
    console.info('Security operation ledger row settled', {
      row_id: row.id,
      provider_ref: params.providerRef,
      intent: params.intent,
      status,
      result_code: params.resultCode,
    });
  } catch (error) {
    console.error('Failed to settle security operation ledger row', {
      row_id: row.id,
      status,
      result_code: params.resultCode,
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
}

/** Extracts the ledger join identity from a queue message body, if present. */
function ledgerSettleIdentityFromMessage(body: unknown): {
  providerRef: string;
  intent: 'manual_sync' | 'dismiss_finding';
  dispatchedAt: string;
  userId?: string;
  actorEmail?: string | null;
} | null {
  const dismiss = SecurityDismissMessageSchema.safeParse(body);
  if (dismiss.success) {
    return {
      providerRef: dismiss.data.messageId,
      intent: 'dismiss_finding',
      dispatchedAt: dismiss.data.dispatchedAt,
      userId: dismiss.data.actor.id,
    };
  }
  const sync = SecuritySyncMessageSchema.safeParse(body);
  if (sync.success) {
    return {
      providerRef: sync.data.messageId,
      intent: 'manual_sync',
      dispatchedAt: sync.data.dispatchedAt,
      userId: sync.data.actor?.id,
      actorEmail: sync.data.actor?.email,
    };
  }
  return null;
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
    if (running.command && isTerminalSecurityLedgerStatus(running.command.status)) {
      await settleSecurityLedgerByProviderRef(db, {
        providerRef: parsed.data.messageId,
        intent: 'dismiss_finding',
        status: running.command.status,
        resultCode: running.command.result_code ?? 'UNKNOWN',
        userId: parsed.data.actor.id,
        dispatchedAt: parsed.data.dispatchedAt,
      });
    }
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
  await settleSecurityLedgerByProviderRef(db, {
    providerRef: parsed.data.messageId,
    intent: 'dismiss_finding',
    status: result.commandStatus,
    resultCode: result.resultCode,
    userId: parsed.data.actor.id,
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
      if (running.command && isTerminalSecurityLedgerStatus(running.command.status)) {
        await settleSecurityLedgerByProviderRef(db, {
          providerRef: body.messageId,
          intent: 'manual_sync',
          status: running.command.status,
          resultCode: running.command.result_code ?? 'UNKNOWN',
          userId: body.actor?.id,
          actorEmail: body.actor?.email,
          dispatchedAt: body.dispatchedAt,
        });
      }
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
  }
  await settleSecurityLedgerByProviderRef(db, {
    providerRef: body.messageId,
    intent: 'manual_sync',
    status: terminal.status,
    resultCode: terminal.resultCode,
    userId: body.actor?.id,
    actorEmail: body.actor?.email,
    dispatchedAt: body.dispatchedAt,
    repoCount: result.synced,
    errorCount: result.errors,
  });
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
            if (isTerminalSecurityAgentCommandTransitionOutcome(exhaustionOutcome)) {
              const settleIdentity = ledgerSettleIdentityFromMessage(message.body);
              if (settleIdentity) {
                await settleSecurityLedgerByProviderRef(db, {
                  providerRef: settleIdentity.providerRef,
                  intent: settleIdentity.intent,
                  status: 'failed',
                  resultCode: 'QUEUE_RETRIES_EXHAUSTED',
                  userId: settleIdentity.userId,
                  actorEmail: settleIdentity.actorEmail,
                  dispatchedAt: settleIdentity.dispatchedAt,
                });
              }
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
