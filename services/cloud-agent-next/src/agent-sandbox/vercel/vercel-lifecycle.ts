import { logger } from '../../logger.js';
import { getSandboxProvider, type SessionMetadata } from '../../persistence/session-metadata.js';
import type {
  AgentSandboxLifecycle,
  AgentSandboxLifecycleHost,
  ProviderDeletionPlan,
  SessionDeletionIntent,
} from '../protocol.js';
import {
  parseVercelSandboxCredentials,
  type VercelSandboxCredentials,
  type VercelSandboxRuntimeConfigEnv,
} from './vercel-runtime-config.js';
import {
  claimVercelStopAttempt,
  classifyVercelSession,
  parseVercelCreateIntent,
  parseVercelStopTombstone,
  retryVercelStopAttempt,
  VERCEL_CREATE_INTENT_KEY,
  VERCEL_CREATE_RETRY_DELAY_MS,
  VERCEL_DELETION_TOMBSTONE_KEY,
  VERCEL_STOP_ATTEMPT_TIMEOUT_MS,
  type VercelCreateIntent,
  type VercelStopTombstone,
} from './vercel-runtime-state.js';
import { VercelSandboxRestClient, VercelSandboxRestError } from './vercel-sandbox-rest-client.js';

const RECONCILE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const MANUAL_REMEDIATION_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reconciles durable Vercel runtime state (create intents and deletion
 * tombstones) against the Vercel API until it reaches a terminal state.
 * Every method self-guards on stored state: sessions on other providers
 * never persist these keys, so all methods reduce to no-ops for them.
 */
export class VercelSandboxLifecycle implements AgentSandboxLifecycle {
  constructor(
    private readonly env: VercelSandboxRuntimeConfigEnv,
    private readonly host: AgentSandboxLifecycleHost
  ) {}

  restClient(credentials: VercelSandboxCredentials, projectId?: string): VercelSandboxRestClient {
    return new VercelSandboxRestClient({
      accessToken: credentials.accessToken,
      projectId,
      teamId: credentials.teamId,
      fetch,
    });
  }

  async planDeletion(input: {
    metadata: SessionMetadata;
    intent: SessionDeletionIntent;
    now: number;
  }): Promise<ProviderDeletionPlan> {
    const { metadata, intent, now } = input;
    if (getSandboxProvider(metadata) !== 'vercel') return { kind: 'not-applicable' };
    const sandboxName = metadata.workspace?.sandboxId;
    if (!sandboxName) return { kind: 'complete' };
    const createIntentRaw = await this.host.storage.get(VERCEL_CREATE_INTENT_KEY);
    const createIntent =
      createIntentRaw === undefined ? undefined : parseVercelCreateIntent(createIntentRaw);
    const sessionId = metadata.workspace?.providerRuntime?.sessionId;
    if (!sessionId && !createIntent) return { kind: 'complete' };
    const tombstone = parseVercelStopTombstone({
      version: 2,
      provider: 'vercel',
      sandboxName,
      sessionId,
      unresolvedCreate: createIntent
        ? {
            operationId: createIntent.operationId,
            projectId: createIntent.projectId,
            snapshotId: createIntent.snapshotId,
            runtimeBuildId: createIntent.runtimeBuildId,
            runtime: createIntent.runtime,
            settleUntil: createIntent.settleUntil,
          }
        : undefined,
      intent,
      stop: { status: 'needed', attempts: 0, nextAttemptAt: now },
    });
    if ('status' in tombstone) throw new Error('Unexpected legacy Vercel deletion tombstone');
    return { kind: 'deferred', entries: { [VERCEL_DELETION_TOMBSTONE_KEY]: tombstone } };
  }

  async reconcilePendingDeletion(now: number): Promise<'handled' | 'none'> {
    const raw = await this.host.storage.get(VERCEL_DELETION_TOMBSTONE_KEY);
    if (raw === undefined) return 'none';
    const tombstone = parseVercelStopTombstone(raw);
    if ('status' in tombstone) {
      logger.error('Legacy Vercel deletion tombstone requires manual remediation');
      await this.host.scheduleAlarmAtOrBefore(now + MANUAL_REMEDIATION_RETRY_INTERVAL_MS);
      return 'handled';
    }
    const retryAt =
      tombstone.stop.status === 'stopping'
        ? tombstone.stop.attemptDeadlineAt
        : tombstone.stop.nextAttemptAt;
    if (now < retryAt) {
      await this.host.scheduleAlarmAtOrBefore(retryAt);
      return 'handled';
    }
    await this.reconcileDeletion(tombstone, now);
    return 'handled';
  }

  private async retainDeletionForRetry(
    tombstone: VercelStopTombstone,
    attemptId: string,
    now: number
  ): Promise<void> {
    const retryAt = now + RECONCILE_RETRY_INTERVAL_MS;
    const retrying = retryVercelStopAttempt(tombstone, attemptId, retryAt) ?? tombstone;
    await this.host.storage.put(VERCEL_DELETION_TOMBSTONE_KEY, retrying);
    await this.host.scheduleAlarmAtOrBefore(retryAt);
  }

  private async reconcileDeletion(tombstone: VercelStopTombstone, now: number): Promise<void> {
    await this.host.purgeDeletedSessionPayload();
    const credentials = parseVercelSandboxCredentials(this.env);
    if (!credentials) {
      await this.host.scheduleAlarmAtOrBefore(now + RECONCILE_RETRY_INTERVAL_MS);
      return;
    }
    let current = tombstone;
    const unresolved = current.unresolvedCreate;
    const client = this.restClient(credentials, unresolved?.projectId);

    if (!current.sessionId && unresolved) {
      try {
        const observation = await client.inspectByName({
          name: current.sandboxName,
          operationId: unresolved.operationId,
          runtimeBuildId: unresolved.runtimeBuildId,
          snapshotId: unresolved.snapshotId,
          runtime: unresolved.runtime,
        });
        if (observation) {
          current = { ...current, sessionId: observation.session.id };
          await this.host.storage.put(VERCEL_DELETION_TOMBSTONE_KEY, current);
        } else if (now >= unresolved.settleUntil) {
          await this.host.eraseDurableObjectState();
          return;
        } else {
          await this.host.scheduleAlarmAtOrBefore(now + RECONCILE_RETRY_INTERVAL_MS);
          return;
        }
      } catch (error) {
        logger
          .withFields({
            sessionId: this.host.getSessionIdForLogs(),
            error: error instanceof Error ? error.message : String(error),
          })
          .warn('Vercel late-create reconciliation remains unresolved');
        await this.host.scheduleAlarmAtOrBefore(now + RECONCILE_RETRY_INTERVAL_MS);
        return;
      }
    }

    if (!current.sessionId) return;
    const attemptId = crypto.randomUUID();
    const claimed = claimVercelStopAttempt(
      current,
      attemptId,
      now,
      now + VERCEL_STOP_ATTEMPT_TIMEOUT_MS
    );
    if (!claimed) {
      const retryAt =
        current.stop.status === 'stopping'
          ? current.stop.attemptDeadlineAt
          : current.stop.nextAttemptAt;
      await this.host.scheduleAlarmAtOrBefore(retryAt);
      return;
    }
    await this.host.storage.put(VERCEL_DELETION_TOMBSTONE_KEY, claimed);
    const claimedSessionId = claimed.sessionId;
    if (!claimedSessionId) throw new Error('Claimed Vercel stop is missing its exact session ID');

    try {
      const stopped = await client.stopSession(claimedSessionId, claimed.sandboxName);
      if (classifyVercelSession(stopped.status, { notFoundIsTerminal: true }) === 'terminal') {
        await this.host.eraseDurableObjectState();
        return;
      }
    } catch {
      try {
        const inspected = await client.getSession(claimedSessionId, claimed.sandboxName);
        if (
          classifyVercelSession(inspected.session.status, { notFoundIsTerminal: true }) ===
          'terminal'
        ) {
          await this.host.eraseDurableObjectState();
          return;
        }
      } catch (inspectionError) {
        if (inspectionError instanceof VercelSandboxRestError && inspectionError.status === 404) {
          await this.host.eraseDurableObjectState();
          return;
        }
      }
    }
    await this.retainDeletionForRetry(claimed, attemptId, now);
  }

  async reconcileCreateIntent(now: number): Promise<void> {
    const raw = await this.host.storage.get(VERCEL_CREATE_INTENT_KEY);
    if (raw === undefined) return;
    const intent = parseVercelCreateIntent(raw);
    if (now < intent.nextRetryAt) {
      await this.host.scheduleAlarmAtOrBefore(intent.nextRetryAt);
      return;
    }
    const credentials = parseVercelSandboxCredentials(this.env);
    if (!credentials) {
      await this.host.scheduleAlarmAtOrBefore(now + RECONCILE_RETRY_INTERVAL_MS);
      return;
    }
    const retrying = {
      ...intent,
      attempts: intent.attempts + 1,
      nextRetryAt: now + VERCEL_CREATE_RETRY_DELAY_MS,
    } satisfies VercelCreateIntent;
    await this.host.storage.put(VERCEL_CREATE_INTENT_KEY, retrying);
    try {
      const observation = await this.restClient(credentials, intent.projectId).inspectByName({
        name: intent.sandboxName,
        operationId: intent.operationId,
        runtimeBuildId: intent.runtimeBuildId,
        snapshotId: intent.snapshotId,
        runtime: intent.runtime,
      });
      if (observation) {
        await this.host.runtimeContext.persistRuntimeOnce({
          provider: 'vercel',
          sessionId: observation.session.id,
          projectId: intent.projectId,
          snapshotId: intent.snapshotId,
          runtimeBuildId: intent.runtimeBuildId,
          runtime: intent.runtime,
        });
        return;
      }
      if (now >= intent.settleUntil) {
        await this.host.runtimeContext.clearCreateIntent(intent.operationId);
        return;
      }
    } catch (error) {
      logger
        .withFields({
          provider: 'vercel',
          operation: 'reconcile-create',
          sandboxName: intent.sandboxName,
          attempt: retrying.attempts,
          failureClass: error instanceof VercelSandboxRestError ? error.kind : 'unknown',
        })
        .warn('Vercel create intent remains unresolved');
    }
    await this.host.scheduleAlarmAtOrBefore(retrying.nextRetryAt);
  }
}
