import { randomUUID } from 'crypto';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
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
  .refine(owner => Boolean(owner.organizationId || owner.userId), {
    message: 'organizationId or userId is required',
  });

export const ManualAnalysisStartCommandSchema = z.object({
  schemaVersion: z.literal(1),
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

export type ManualAnalysisStartCommand = z.infer<typeof ManualAnalysisStartCommandSchema>;

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
      errorMessage: tokenResult.reason,
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
    throw error;
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

export async function consumeManualAnalysisBatch(
  batch: MessageBatch<unknown>,
  env: CloudflareEnv
): Promise<void> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  for (const message of batch.messages) {
    const parsed = ManualAnalysisStartCommandSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      await processManualAnalysisStart({ db, env, command: parsed.data });
      message.ack();
    } catch (error) {
      console.error('Manual security analysis start failed', {
        findingId: parsed.data.findingId,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
    }
  }
}
