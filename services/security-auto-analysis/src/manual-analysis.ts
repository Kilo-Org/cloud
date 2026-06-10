import { randomUUID } from 'crypto';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  isTerminalSecurityAgentCommandTransitionOutcome,
  markSecurityAgentCommandRetriesExhausted,
  requireSecurityAgentCommandTransitionOrTerminal,
  transitionSecurityAgentCommandWithCurrentState,
  type SecurityAgentCommandTransitionOutcome,
} from '@kilocode/db';
import { security_audit_log } from '@kilocode/db/schema';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import { z } from 'zod';
import {
  countOwnerInflightAnalyses,
  ensureManualAnalysisQueueRow,
  getAnalysisActorById,
  getSecurityAgentConfigForOwner,
  getSecurityFindingById,
  transitionManualAnalysisQueueFromStart,
  type SecurityFindingRecord,
} from './db/queries.js';
import { transitionAnalysisStartLifecycle } from './analysis-start-lifecycle.js';
import { InsufficientCreditsError, startSecurityAnalysis } from './launch.js';
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
  retrySandboxOnly: z.boolean().optional(),
});

export const ManualAnalysisStartRequestSchema = ManualAnalysisStartCommandSchema.omit({
  commandId: true,
});

export type ManualAnalysisStartCommand = z.infer<typeof ManualAnalysisStartCommandSchema>;

const MANUAL_ANALYSIS_COMMAND_MAX_ATTEMPTS = 4;

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
  const inflight = await countOwnerInflightAnalyses(params.db, owner);
  if (inflight >= SECURITY_ANALYSIS_OWNER_CAP) return { status: 'owner-cap' };
  const actor = await getAnalysisActorById(params.db, params.command.actorUserId);
  if (!actor) return { status: 'actor-missing' };

  const claimToken = randomUUID();
  const jobId = `manual:${claimToken}`;
  if (!(await ensureManualAnalysisQueueRow(params.db, { finding, claimToken, jobId }))) {
    return { status: 'duplicate' };
  }

  const tokenResult = await params.env.GIT_TOKEN_SERVICE.getTokenForRepo({
    githubRepo: finding.repo_full_name,
    userId: actor.id,
    orgId: owner.type === 'org' ? owner.id : undefined,
  });
  if (!tokenResult.success) {
    await transitionManualAnalysisQueueFromStart(params.db, {
      findingId: finding.id,
      claimToken,
      status: 'failed',
      failureCode: 'GITHUB_TOKEN_UNAVAILABLE',
      errorMessage: 'GitHub token unavailable',
    });
    return { status: 'token-missing' };
  }

  const config = await getSecurityAgentConfigForOwner(params.db, owner);
  const resolvedModels = resolveSecurityAgentModels(config);
  const triageModel =
    params.command.requestedModels?.triageModel ??
    params.command.requestedModels?.model ??
    resolvedModels.triageModel;
  const analysisModel =
    params.command.requestedModels?.analysisModel ??
    params.command.requestedModels?.model ??
    resolvedModels.analysisModel;
  const [nextAuthSecret, internalApiSecret, callbackTokenSecret] = await Promise.all([
    params.env.NEXTAUTH_SECRET.get(),
    params.env.INTERNAL_API_SECRET.get(),
    params.env.CALLBACK_TOKEN_SECRET.get(),
  ]);
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
      organizationId: owner.type === 'org' ? owner.id : undefined,
      nextAuthSecret,
      internalApiSecret,
      callbackTokenSecret,
      retrySandboxOnly: params.command.retrySandboxOnly,
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
          failureCode: 'START_CALL_AMBIGUOUS',
          incrementAttempt: false,
          nextRetryAt: null,
        },
      });
    } else {
      await transitionManualAnalysisQueueFromStart(params.db, {
        findingId: finding.id,
        claimToken,
        status: 'failed',
        failureCode: 'START_CALL_AMBIGUOUS',
        errorMessage: result.error ?? null,
      });
    }
    return { status: 'failed' };
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
    },
  });
  return { status: 'started' };
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
      return { status: 'succeeded', resultCode: 'ANALYSIS_LAUNCH_STARTED' };
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

      const result = await processManualAnalysisStart({ db, env, command: parsed.data });
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
