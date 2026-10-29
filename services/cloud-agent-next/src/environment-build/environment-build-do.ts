import { DurableObject } from 'cloudflare:workers';
import { isEnvironmentSnapshotsEnabled } from './enrollment.js';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { timingSafeEqual } from '@kilocode/encryption';
import {
  loadEnvironmentBuildInput,
  readEnvironmentReference,
  type EnvironmentReference,
} from '@kilocode/cloud-agent-profile';
import { resolveSecret } from '../auth.js';
import {
  assertContainerCapacity,
  getContainerCapacityFailureReason,
} from '../container-concurrency.js';
import { isCloudAgentContainerBillingEnabled } from '../container-billing-rollout.js';
import { getPgDb } from '../db/pg.js';
import { logger } from '../logger.js';
import { mergeEnvVarsWithSecrets, type EncryptedSecrets } from '../utils/encryption.js';
import type { Env } from '../types.js';
import type {
  EnvironmentBuildEvents,
  EnvironmentBuildEventsReply,
  EnvironmentBuildInput,
  EnvironmentBuildResult,
} from '../shared/environment-build-protocol.js';
import type {
  EnvironmentBuildCancelResult,
  EnvironmentBuildLogs,
  EnvironmentBuildRequestResult,
  EnvironmentBuildStatus,
} from '../shared/environment-build-status.js';
import { environmentActorAccess, resolveBuilderGitSource } from './access.js';
import { builderSandboxId, createBuilderProvider } from './builder-provider.js';
import { resolveEnvironmentBuildTarget, snapshotsRuntimeUnsupportedReason } from './target.js';
import {
  EnvironmentBuildCoordinator,
  type CoordinatorDeps,
  type RunnerAuth,
  type RunnerRefusal,
  type SnapshotResolution,
} from './coordinator.js';
import { mintRunnerCredential } from './runner-credential.js';
import type { SessionEnvironmentReference } from './reference.js';
import type { BuildTrigger } from './sqlite-schema.js';
import { BuildStore } from './store.js';
import migrations from './drizzle/migrations';

/**
 * One coordinator per environment id (`idFromName(environmentId)`). The DO is a
 * thin host: it migrates its SQLite, builds the coordinator's dependencies from
 * the Worker environment and forwards each RPC and the alarm.
 */

/** The derived runner credential: an HMAC over the build and allocation, never stored. */
async function deriveRunnerCredential(
  secret: string,
  claims: { environmentId: string; buildId: string; allocationId: string }
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `environment-build-runner:v1:${claims.environmentId}:${claims.buildId}:${claims.allocationId}`;
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function billingSubject(owner: EnvironmentReference['owner']) {
  return owner.type === 'organization'
    ? { type: 'org' as const, id: owner.id }
    : { type: 'user' as const, id: owner.id };
}

export class EnvironmentBuild extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;
  private readonly store: BuildStore;
  private readonly initialized: Promise<void>;
  private coordinator: EnvironmentBuildCoordinator | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    this.store = new BuildStore(this.db);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  private async coordinatorFor(environmentId: string): Promise<EnvironmentBuildCoordinator> {
    await this.initialized;
    if (this.coordinator !== undefined) return this.coordinator;
    const bound = this.store.environment();
    if (bound !== null && bound.environmentId !== environmentId) {
      throw new Error('Environment build coordinator serves another environment');
    }
    const sandboxId = await builderSandboxId(environmentId);
    this.coordinator = new EnvironmentBuildCoordinator(environmentId, this.createDeps(sandboxId));
    return this.coordinator;
  }

  private createDeps(sandboxId: string): CoordinatorDeps {
    const env = this.env;
    const storage = this.ctx.storage;
    const signingSecret = async (): Promise<string> => {
      const secret = await resolveSecret(env.NEXTAUTH_SECRET);
      if (!secret) throw new Error('Environment build signing secret is unavailable');
      return secret;
    };
    return {
      now: () => Date.now(),
      uuid: () => crypto.randomUUID(),
      store: this.store,
      transaction: write => storage.transactionSync(write),
      armAlarm: async at => {
        const current = await storage.getAlarm();
        if (current === null || at < current) await storage.setAlarm(at);
      },
      environment: {
        reference: id => readEnvironmentReference(getPgDb(env), id),
        buildInput: id => loadEnvironmentBuildInput(getPgDb(env), id),
        actorAccess: (owner, userId) => environmentActorAccess(getPgDb(env), owner, userId),
        gitSource: input => resolveBuilderGitSource(env, input),
        buildTarget: input =>
          resolveEnvironmentBuildTarget({
            env,
            db: getPgDb(env),
            reference: input.reference,
            repoFullName: input.repoFullName,
            commands: input.commands,
            sandboxAllocation: input.sandboxAllocation,
          }),
        capacity: async (owner, instanceId, actorUserId) => {
          try {
            await assertContainerCapacity(env, {
              subject: billingSubject(owner),
              instanceId,
              actor: { type: 'user', id: actorUserId },
              checkpoint: 'sandbox-start',
            });
            return 'ok';
          } catch (error) {
            if (getContainerCapacityFailureReason(error) === 'container_limit_reached')
              return 'limit_reached';
            throw error;
          }
        },
      },
      provider: createBuilderProvider({
        containers: env.SANDBOX_CONTAINERS,
        env,
      }),
      lifecycle: buildId => {
        const key = `environment-build:lifecycle:v1:${buildId}`;
        return {
          get: () => storage.get(key),
          set: async value => {
            await storage.put(key, value);
          },
          clear: async () => {
            await storage.delete(key);
          },
        };
      },
      runnerUrl: (environmentId, buildId) => {
        const base = env.WORKER_URL?.replace(/\/$/, '');
        return base ? `${base}/environment-build/${environmentId}/${buildId}` : null;
      },
      runnerCredential: async claims => {
        const secret = await signingSecret();
        return mintRunnerCredential(
          { ...claims, credential: await deriveRunnerCredential(secret, claims) },
          secret
        );
      },
      runnerCredentialMatches: async (claims, credential) => {
        const secret = await signingSecret();
        return timingSafeEqual(await deriveRunnerCredential(secret, claims), credential);
      },
      decryptSecrets: encrypted =>
        mergeEnvVarsWithSecrets({}, encrypted as EncryptedSecrets, env.AGENT_ENV_VARS_PRIVATE_KEY),
      billingInput: ({ owner, actorUserId, sandboxId: billingSandboxId, buildId }) => {
        const enforcementRequested = isCloudAgentContainerBillingEnabled(env, {
          userId: actorUserId,
          ...(owner.type === 'organization' ? { orgId: owner.id } : {}),
        });
        return {
          sandboxId: billingSandboxId as never,
          sandboxKind: 'isolated',
          subject: billingSubject(owner),
          actor: { type: 'user', id: actorUserId },
          sessionId: `environment-build:${buildId}`,
          metadata: { origin: 'environment-build' },
          ...(enforcementRequested ? { enforcementRequested: true } : {}),
        };
      },
      builderSandboxId: sandboxId,
      unsupportedReason: owner => {
        if (!isEnvironmentSnapshotsEnabled(env, owner)) {
          return 'Snapshots are not enabled for this organization';
        }
        return snapshotsRuntimeUnsupportedReason(env);
      },
      log: (message, fields) => logger.withFields(fields).info(message),
    };
  }

  // --- public operations (authorized by the Worker handler) -------------------

  async requestBuild(input: {
    environmentId: string;
    owner: EnvironmentReference['owner'];
    expectedRevision: number;
    requestId: string;
    trigger: BuildTrigger;
    actorUserId: string;
  }): Promise<EnvironmentBuildRequestResult> {
    const { environmentId, ...request } = input;
    return (await this.coordinatorFor(environmentId)).requestBuild(request);
  }

  async status(input: {
    environmentId: string;
    owner: EnvironmentReference['owner'];
    configurationRevision: number;
  }): Promise<EnvironmentBuildStatus> {
    return await (
      await this.coordinatorFor(input.environmentId)
    ).status(input.configurationRevision, input.owner);
  }

  async logs(input: {
    environmentId: string;
    buildId: string;
    cursor?: number;
    limit: number;
  }): Promise<EnvironmentBuildLogs | null> {
    return (await this.coordinatorFor(input.environmentId)).logs(
      input.buildId,
      input.cursor,
      input.limit
    );
  }

  async cancel(input: {
    environmentId: string;
    buildId: string;
  }): Promise<EnvironmentBuildCancelResult> {
    return (await this.coordinatorFor(input.environmentId)).cancel(input.buildId);
  }

  async environmentDeleted(input: { environmentId: string }): Promise<void> {
    await (await this.coordinatorFor(input.environmentId)).environmentDeleted();
  }

  // --- session launch (Sandbox DO) --------------------------------------------

  async resolveSnapshot(input: {
    reference: SessionEnvironmentReference;
    actorUserId: string;
  }): Promise<SnapshotResolution> {
    return (await this.coordinatorFor(input.reference.environmentId)).resolveSnapshot(input);
  }

  // --- builder callbacks (authenticated Worker routes) ------------------------

  async runnerInput(auth: RunnerAuth): Promise<EnvironmentBuildInput | RunnerRefusal> {
    return (await this.coordinatorFor(auth.environmentId)).runnerInput(auth);
  }

  async runnerEvents(
    auth: RunnerAuth,
    events: EnvironmentBuildEvents
  ): Promise<EnvironmentBuildEventsReply | RunnerRefusal> {
    return (await this.coordinatorFor(auth.environmentId)).runnerEvents(auth, events);
  }

  async runnerResult(
    auth: RunnerAuth,
    result: EnvironmentBuildResult
  ): Promise<'ok' | RunnerRefusal> {
    return (await this.coordinatorFor(auth.environmentId)).runnerResult(auth, result);
  }

  async alarm(): Promise<void> {
    await this.initialized;
    const bound = this.store.environment();
    if (bound === null) return;
    await (await this.coordinatorFor(bound.environmentId)).alarm();
  }
}
