import { randomUUID } from 'crypto';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  isTerminalSecurityAgentCommandTransitionOutcome,
  markSecurityAgentCommandRetriesExhausted,
  requireSecurityAgentCommandTransitionOrTerminal,
  transitionSecurityAgentCommandWithCurrentState,
  type SecurityAgentCommandTransitionOutcome,
} from '@kilocode/db';
import {
  security_audit_log,
  security_analysis_owner_state,
  security_analysis_queue,
  security_findings,
} from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import { resolveRuntimeEnvironment } from '@kilocode/worker-utils/runtime-authorization-contract';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ensureManualAnalysisQueueRow,
  getAnalysisActorById,
  getSecurityAgentConfigForOwner,
  getSecurityFindingById,
  prepareActiveAnalysisRestart,
  releaseOrphanedStartReservation,
  transitionManualAnalysisQueueFromStart,
  tryAcquireAnalysisStartLease,
  type SecurityFindingRecord,
} from './db/queries.js';
import { transitionAnalysisStartLifecycle } from './analysis-start-lifecycle.js';
import { InsufficientCreditsError, startSecurityAnalysis } from './launch.js';
import { interruptAnalysisCloudAgentSession } from './session-interrupt.js';
import { generateControlToken } from './token.js';
import {
  resolveSecurityAgentModels,
  SECURITY_ANALYSIS_OWNER_CAP,
  type QueueOwner,
} from './types.js';

const ManualAnalysisOwnerSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    userId: z.string().min(1).optional(),
  })
  .refine(owner => Boolean(owner.organizationId) !== Boolean(owner.userId), {
    message: 'exactly one of organizationId or userId is required',
  });

export const ManualAnalysisStartCommandSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.string().uuid(),
  findingId: z.string().uuid(),
  owner: ManualAnalysisOwnerSchema,
  actorUserId: z.string().min(1),
  requestedModels: z
    .object({
      model: z.string().optional(),
      triageModel: z.string().optional(),
      analysisModel: z.string().optional(),
    })
    .optional(),
  forceSandbox: z.boolean().optional(),
  retrySandboxOnly: z.boolean().optional(),
  restartActive: z.boolean().optional(),
});

export const ManualAnalysisStartRequestSchema = ManualAnalysisStartCommandSchema.omit({
  commandId: true,
});

export type ManualAnalysisStartCommand = z.infer<typeof ManualAnalysisStartCommandSchema>;

/**
 * Deliveries a manual start command may take. The `security-manual-analysis-command-queue`
 * consumer in wrangler.jsonc allows `max_retries: 3`, so the last delivery the handler sees
 * is attempt `max_retries + 1`; the exhaustion path below relies on that equality to settle
 * the command instead of retrying it into the dead letter queue. manual-analysis.test.ts
 * reads wrangler.jsonc and fails when the two drift apart.
 */
export const MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS = 4;

/**
 * Backoff for a replayed start: 30s, 60s, then 120s, capped there. Without it the deliveries
 * are consumed back to back and the whole budget settles within seconds although the reason
 * for the replay (an admission read that could not decide) is transient.
 */
function manualAnalysisRetryDelaySeconds(attempts: number): number {
  const baseDelaySeconds = 30;
  const maxDelaySeconds = 120;
  return Math.min(maxDelaySeconds, baseDelaySeconds * 2 ** Math.max(0, attempts - 1));
}

/**
 * A manual start whose credit admission read could not decide. Nothing is
 * written for it: the queue row keeps this command's claim and the finding
 * keeps its pending reservation, so the consumer's retry replays the same
 * command payload with the same parameters.
 */
export class RetryableManualAnalysisStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableManualAnalysisStartError';
  }
}

function commandOwner(command: ManualAnalysisStartCommand): QueueOwner {
  return command.owner.organizationId
    ? { type: 'org', id: command.owner.organizationId }
    : { type: 'user', id: command.owner.userId ?? command.actorUserId };
}

function findingMatchesOwner(
  finding: Pick<SecurityFindingRecord, 'owned_by_organization_id' | 'owned_by_user_id'>,
  owner: QueueOwner
): boolean {
  return owner.type === 'org'
    ? finding.owned_by_organization_id === owner.id
    : finding.owned_by_user_id === owner.id;
}

export async function processManualAnalysisStart(params: {
  db: WorkerDb;
  env: CloudflareEnv;
  command: ManualAnalysisStartCommand;
  /**
   * Whether this delivery is the last one the consumer's attempt budget
   * allows. A start that could not decide is replayed through the command
   * message until then, and settled as failed on the final delivery.
   */
  isFinalAttempt: boolean;
}): Promise<{
  status:
    | 'started'
    | 'duplicate'
    | 'owner-cap'
    | 'finding-missing'
    | 'actor-missing'
    | 'token-missing'
    | 'failed';
  resultCode?: string;
}> {
  const owner = commandOwner(params.command);
  const finding = await getSecurityFindingById(params.db, params.command.findingId);
  if (!finding || !findingMatchesOwner(finding, owner)) {
    return { status: 'finding-missing' };
  }
  const isActiveRestart = params.command.restartActive === true;
  if (!finding.platform_integration_id) {
    // The command has no launch path; clear the pending admission state.
    await releaseOrphanedStartReservation(params.db, finding.id);
    return { status: 'token-missing' };
  }
  let preReserved = false;
  if (!isActiveRestart) {
    // Admission decision under the per-owner lock (the same
    // `security_analysis_owner_state` row the scheduled claim path locks).
    // A finding already `pending` carries the web's admission reservation, so
    // its slot is already counted at reservation time and the count here must
    // not include it again.
    const admission = await params.db.transaction(async tx => {
      const ownerValues =
        owner.type === 'org'
          ? { owned_by_organization_id: owner.id, owned_by_user_id: null }
          : { owned_by_organization_id: null, owned_by_user_id: owner.id };
      await tx.insert(security_analysis_owner_state).values(ownerValues).onConflictDoNothing();
      await tx
        .select({ id: security_analysis_owner_state.id })
        .from(security_analysis_owner_state)
        .where(
          owner.type === 'org'
            ? eq(security_analysis_owner_state.owned_by_organization_id, owner.id)
            : eq(security_analysis_owner_state.owned_by_user_id, owner.id)
        )
        .for('update')
        .limit(1);

      const [findingStatus] = await tx
        .select({
          analysisStatus: security_findings.analysis_status,
          status: security_findings.status,
        })
        .from(security_findings)
        .where(eq(security_findings.id, params.command.findingId))
        .limit(1);
      const status = findingStatus?.analysisStatus ?? null;
      if (findingStatus && findingStatus.status !== 'open') {
        return { kind: 'not_eligible' } as const;
      }
      if (status === 'running') {
        return { kind: 'in_progress' } as const;
      }
      if (status === 'pending') {
        return { kind: 'pre_reserved' } as const;
      }

      // Inflight = findings already pending/running plus scheduled queue
      // claims that reserve a slot while the finding status is still null.
      // Distinct by finding so a counted finding cannot add a second slot.
      const [inflight] = await tx
        .select({ total: sql<number>`count(distinct ${security_findings.id})` })
        .from(security_findings)
        .leftJoin(
          security_analysis_queue,
          eq(security_analysis_queue.finding_id, security_findings.id)
        )
        .where(
          and(
            owner.type === 'org'
              ? eq(security_findings.owned_by_organization_id, owner.id)
              : eq(security_findings.owned_by_user_id, owner.id),
            or(
              inArray(security_findings.analysis_status, ['pending', 'running']),
              and(
                isNull(security_findings.analysis_status),
                inArray(security_analysis_queue.queue_status, ['pending', 'running'])
              )
            ),
            ne(security_findings.id, params.command.findingId)
          )
        );
      if ((inflight?.total ?? 0) >= SECURITY_ANALYSIS_OWNER_CAP) {
        return { kind: 'owner_cap' } as const;
      }
      const leased = await tryAcquireAnalysisStartLease(tx, params.command.findingId);
      if (!leased) {
        return { kind: 'in_progress' } as const;
      }
      return { kind: 'leased' } as const;
    });

    if (admission.kind === 'owner_cap') {
      await releaseOrphanedStartReservation(params.db, finding.id);
      return { status: 'owner-cap' };
    }
    if (admission.kind === 'not_eligible') {
      await releaseOrphanedStartReservation(params.db, finding.id);
      return { status: 'finding-missing' };
    }
    if (admission.kind === 'in_progress') {
      return { status: 'duplicate' };
    }
    // Both `pre_reserved` (web admission) and `leased` (taken here) leave the
    // finding `pending`; the lease step in `startSecurityAnalysis` must not
    // run again against that state.
    preReserved = true;
  }

  const actor = await getAnalysisActorById(params.db, params.command.actorUserId);
  if (!actor) {
    await releaseOrphanedStartReservation(params.db, finding.id);
    return { status: 'actor-missing' };
  }

  let claimToken: string;
  let tokenResult: GitTokenForRepoResult;
  let config: Awaited<ReturnType<typeof getSecurityAgentConfigForOwner>>;
  let nextAuthSecret: string;
  let internalApiSecret: string;
  let callbackTokenSecret: string;

  if (isActiveRestart) {
    [tokenResult, config, nextAuthSecret, internalApiSecret, callbackTokenSecret] =
      await Promise.all([
        params.env.GIT_TOKEN_SERVICE.getTokenForRepo({
          githubRepo: finding.repo_full_name,
          userId: actor.id,
          orgId: owner.type === 'org' ? owner.id : undefined,
          ...(finding.platform_integration_id
            ? { expectedIntegrationId: finding.platform_integration_id }
            : {}),
        }),
        getSecurityAgentConfigForOwner(params.db, owner),
        params.env.NEXTAUTH_SECRET.get(),
        params.env.INTERNAL_API_SECRET.get(),
        params.env.CALLBACK_TOKEN_SECRET.get(),
      ]);
    if (!tokenResult.success) return { status: 'token-missing' };

    const authToken = await generateControlToken(
      actor,
      nextAuthSecret,
      resolveRuntimeEnvironment(params.env.ENVIRONMENT),
      params.env.SHARED_RESOURCE_TOKENS_ENABLED,
      owner.type === 'org' ? owner.id : undefined
    );
    const restart = await prepareActiveAnalysisRestart(params.db, {
      findingId: finding.id,
      owner,
      commandId: params.command.commandId,
    });
    if (restart.status !== 'ready') return { status: 'duplicate' };

    claimToken = restart.claimToken;
    if (restart.oldCloudAgentSessionId) {
      await interruptAnalysisCloudAgentSession({
        env: params.env,
        authToken,
        cloudAgentSessionId: restart.oldCloudAgentSessionId,
        findingId: finding.id,
        commandId: params.command.commandId,
      });
    }
  } else {
    claimToken = randomUUID();
    // The job id is stable for the command, so a re-delivered command revives
    // the pending row its earlier delivery claimed instead of reading it as
    // another launch's duplicate.
    const jobId = `manual:${params.command.commandId}`;
    if (!(await ensureManualAnalysisQueueRow(params.db, { finding, claimToken, jobId }))) {
      return { status: 'duplicate' };
    }

    tokenResult = await params.env.GIT_TOKEN_SERVICE.getTokenForRepo({
      githubRepo: finding.repo_full_name,
      userId: actor.id,
      orgId: owner.type === 'org' ? owner.id : undefined,
      ...(finding.platform_integration_id
        ? { expectedIntegrationId: finding.platform_integration_id }
        : {}),
    });
    if (!tokenResult.success) {
      await transitionManualAnalysisQueueFromStart(params.db, {
        findingId: finding.id,
        claimToken,
        status: 'failed',
        failureCode: 'GITHUB_TOKEN_UNAVAILABLE',
        errorMessage: 'GitHub token unavailable',
      });
      await releaseOrphanedStartReservation(params.db, finding.id);
      return { status: 'token-missing' };
    }

    config = await getSecurityAgentConfigForOwner(params.db, owner);
    [nextAuthSecret, internalApiSecret, callbackTokenSecret] = await Promise.all([
      params.env.NEXTAUTH_SECRET.get(),
      params.env.INTERNAL_API_SECRET.get(),
      params.env.CALLBACK_TOKEN_SECRET.get(),
    ]);
  }

  const resolvedModels = resolveSecurityAgentModels(config);
  const triageModel =
    params.command.requestedModels?.triageModel ??
    params.command.requestedModels?.model ??
    resolvedModels.triageModel;
  const analysisModel =
    params.command.requestedModels?.analysisModel ??
    params.command.requestedModels?.model ??
    resolvedModels.analysisModel;
  let result: Awaited<ReturnType<typeof startSecurityAnalysis>>;
  try {
    result = await startSecurityAnalysis({
      db: params.db,
      env: params.env,
      findingId: finding.id,
      actorUser: actor,
      githubToken: tokenResult.token,
      triageModel,
      analysisModel,
      analysisMode: config.analysis_mode,
      nextAuthSecret,
      internalApiSecret,
      callbackTokenSecret,
      forceSandbox: isActiveRestart ? true : params.command.forceSandbox,
      retrySandboxOnly: isActiveRestart ? true : params.command.retrySandboxOnly,
      preReserved: isActiveRestart ? false : preReserved,
      lifecycleClaim: {
        source: 'manual',
        findingId: finding.id,
        claimToken,
      },
    });
  } catch (error) {
    if (!(error instanceof InsufficientCreditsError)) throw error;

    await transitionAnalysisStartLifecycle(params.db, {
      claim: {
        source: 'manual',
        findingId: finding.id,
        claimToken,
      },
      outcome: {
        type: 'start-failed',
        errorMessage: error.message,
        queueStatus: 'failed',
        failureCode: 'INSUFFICIENT_CREDITS',
        incrementAttempt: false,
        nextRetryAt: null,
      },
    });
    return { status: 'failed', resultCode: 'INSUFFICIENT_CREDITS' };
  }
  if (!result.started) {
    if (result.failureNeedsLifecycleTransition) {
      if (result.failureCode === 'REQUEUE_TEMPORARY_PRECONDITION') {
        if (!params.isFinalAttempt) {
          // The admission read could not decide and no paid work ran, so this
          // attempt writes nothing: the queue row keeps this command's claim
          // and the finding keeps its reservation. The consumer retries the
          // command message, and the next delivery replays the same payload
          // with the same parameters.
          throw new RetryableManualAnalysisStartError(
            result.error ?? 'Security analysis start failed'
          );
        }
        // The last allowed delivery gives up. The row is settled terminal, so
        // the stale-row reconciler cannot hand it to the scheduled consumer,
        // which would drop a request the user never enabled for automatic
        // analysis.
        await transitionAnalysisStartLifecycle(params.db, {
          claim: {
            source: 'manual',
            findingId: finding.id,
            claimToken,
          },
          outcome: {
            type: 'start-failed',
            errorMessage: result.error ?? 'Security analysis start failed',
            queueStatus: 'failed',
            failureCode: 'REQUEUE_TEMPORARY_PRECONDITION',
            incrementAttempt: false,
            nextRetryAt: null,
          },
        });
        return { status: 'failed', resultCode: 'REQUEUE_TEMPORARY_PRECONDITION' };
      }
      await transitionAnalysisStartLifecycle(params.db, {
        claim: {
          source: 'manual',
          findingId: finding.id,
          claimToken,
        },
        outcome: {
          type: 'start-failed',
          errorMessage: result.error ?? 'Security analysis start failed',
          queueStatus: 'failed',
          failureCode: result.failureCode ?? 'START_CALL_AMBIGUOUS',
          incrementAttempt: false,
          nextRetryAt: null,
        },
      });
    } else {
      await transitionManualAnalysisQueueFromStart(params.db, {
        findingId: finding.id,
        claimToken,
        status: 'failed',
        failureCode: result.failureCode ?? 'START_CALL_AMBIGUOUS',
        errorMessage: result.error ?? null,
      });
      await releaseOrphanedStartReservation(params.db, finding.id);
    }
    // The command settles with the same code the queue row recorded, so a
    // declared failure keeps its reason instead of collapsing into the generic
    // launch failure.
    return { status: 'failed', resultCode: result.failureCode ?? 'START_CALL_AMBIGUOUS' };
  }

  await params.db.insert(security_audit_log).values({
    owned_by_organization_id: finding.owned_by_organization_id,
    owned_by_user_id: finding.owned_by_user_id,
    actor_id: actor.id,
    actor_email: null,
    actor_name: null,
    action: SecurityAuditLogAction.FindingAnalysisStarted,
    resource_type: 'security_finding',
    resource_id: finding.id,
    metadata: {
      source: 'user',
      model: analysisModel,
      triageModel,
      analysisModel,
      analysisMode: config.analysis_mode,
      triageOnly: result.triageOnly ?? false,
      ...(isActiveRestart ? { restartActive: true } : {}),
    },
  });
  return {
    status: 'started',
    resultCode: isActiveRestart ? 'ANALYSIS_RESTART_STARTED' : undefined,
  };
}

function manualAnalysisCommandTerminalState(result: {
  status:
    | 'started'
    | 'duplicate'
    | 'owner-cap'
    | 'finding-missing'
    | 'actor-missing'
    | 'token-missing'
    | 'failed';
  resultCode?: string;
}): { status: 'succeeded' | 'failed' | 'no_op'; resultCode: string } {
  switch (result.status) {
    case 'started':
      return {
        status: 'succeeded',
        resultCode: result.resultCode ?? 'ANALYSIS_LAUNCH_STARTED',
      };
    case 'duplicate':
      return { status: 'no_op', resultCode: 'ALREADY_IN_PROGRESS' };
    case 'owner-cap':
      return { status: 'failed', resultCode: 'OWNER_CAP_REACHED' };
    case 'finding-missing':
      return { status: 'failed', resultCode: 'FINDING_UNAVAILABLE' };
    case 'actor-missing':
      return { status: 'failed', resultCode: 'ACTOR_RESOLUTION_FAILED' };
    case 'token-missing':
      return { status: 'failed', resultCode: 'GITHUB_TOKEN_UNAVAILABLE' };
    case 'failed':
      return { status: 'failed', resultCode: result.resultCode ?? 'ANALYSIS_LAUNCH_FAILED' };
  }
}

export async function consumeManualAnalysisBatch(
  batch: MessageBatch<unknown>,
  env: CloudflareEnv
): Promise<void> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  for (const message of batch.messages) {
    const parsed = ManualAnalysisStartCommandSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error('Invalid manual security analysis command', { errors: parsed.error.issues });
      message.ack();
      continue;
    }
    try {
      const running = await transitionSecurityAgentCommandWithCurrentState(db, {
        commandId: parsed.data.commandId,
        fromStatuses: ['accepted', 'running'],
        status: 'running',
      });
      if (requireSecurityAgentCommandTransitionOrTerminal(running, 'running') === 'terminal') {
        console.info('Manual security analysis command delivery already terminal', {
          command_id: parsed.data.commandId,
          command_type: 'start_analysis',
          owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
          result_code: running.command?.result_code,
          attempts: message.attempts,
        });
        message.ack();
        continue;
      }

      const result = await processManualAnalysisStart({
        db,
        env,
        command: parsed.data,
        isFinalAttempt: message.attempts >= MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS,
      });
      const terminal = manualAnalysisCommandTerminalState(result);
      const terminalTransition = await transitionSecurityAgentCommandWithCurrentState(db, {
        commandId: parsed.data.commandId,
        fromStatuses: ['running'],
        status: terminal.status,
        resultCode: terminal.resultCode,
      });
      requireSecurityAgentCommandTransitionOrTerminal(terminalTransition, 'terminal');
      console.info('Manual security analysis command completed', {
        command_id: parsed.data.commandId,
        command_type: 'start_analysis',
        owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
        result_code: terminal.resultCode,
        attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      if (
        error instanceof RetryableManualAnalysisStartError &&
        message.attempts < MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS
      ) {
        console.info('Manual security analysis command will replay the start', {
          command_id: parsed.data.commandId,
          command_type: 'start_analysis',
          owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
          attempts: message.attempts,
          max_attempts: MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS,
        });
        message.retry({ delaySeconds: manualAnalysisRetryDelaySeconds(message.attempts) });
        continue;
      }

      let exhaustionOutcome: SecurityAgentCommandTransitionOutcome | undefined;
      if (message.attempts >= MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS) {
        try {
          exhaustionOutcome = await markSecurityAgentCommandRetriesExhausted(
            db,
            parsed.data.commandId
          );
          if (isTerminalSecurityAgentCommandTransitionOutcome(exhaustionOutcome)) {
            console.info(
              'Manual security analysis command delivery already terminal after failure',
              {
                command_id: parsed.data.commandId,
                command_type: 'start_analysis',
                owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
                result_code: exhaustionOutcome.command?.result_code,
                attempts: message.attempts,
              }
            );
            message.ack();
            continue;
          }
        } catch {
          console.error('Failed to record exhausted manual security analysis command', {
            command_id: parsed.data.commandId,
            command_type: 'start_analysis',
            owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
            attempts: message.attempts,
          });
        }
      }

      console.error('Manual security analysis start failed', {
        command_id: parsed.data.commandId,
        command_type: 'start_analysis',
        owner_type: parsed.data.owner.organizationId ? 'org' : 'user',
        attempts: message.attempts,
        result_code: exhaustionOutcome?.transitioned ? 'QUEUE_RETRIES_EXHAUSTED' : undefined,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
      message.retry();
    }
  }
}
