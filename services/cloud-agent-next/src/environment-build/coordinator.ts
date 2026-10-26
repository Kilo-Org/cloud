import type {
  EnvironmentBuildInput as ProfileBuildInput,
  EnvironmentReference,
} from '@kilocode/cloud-agent-profile';
import type { SandboxBillingInput } from '../container-usage-context.js';
import { ProviderCreationError } from '../sandbox-control/provider.js';
import { RUNTIME_BASE_ABI } from '../sandbox-control/runtime-release.js';
import {
  ENVIRONMENT_BUILD_WORKSPACE,
  type EnvironmentBuildEvents,
  type EnvironmentBuildEventsReply,
  type EnvironmentBuildInput,
  type EnvironmentBuildResult,
} from '../shared/environment-build-protocol.js';
import type {
  EnvironmentBuildCancelResult,
  EnvironmentBuildLogs,
  EnvironmentBuildRequestResult,
  EnvironmentBuildStatus,
  EnvironmentBuildSummary,
} from '../shared/environment-build-status.js';
import type { EnvironmentActorAccess, BuilderGitSource } from './access.js';
import {
  builderInstance,
  type BuilderAllocation,
  type BuilderProvider,
} from './builder-provider.js';
import {
  BUILDER_FIRST_REPORT_MS,
  BUILDER_REPORT_LOSS_MS,
  BUILD_DEADLINE_MS,
  CLEANUP_ATTEMPTS_BEFORE_FAILURE,
  COUNTED_FAILURE_REASONS,
  PREPARING_TICK_MS,
  SESSION_PREPARATION_BUDGET_MS,
  SNAPSHOT_ELIGIBLE_LIFETIME_MS,
  automaticAdmission,
  cleanupRetryDelay,
  compatibleWith,
  replacementNeeded,
  snapshotEligibility,
  type SnapshotCompatibility,
  type PublishedSnapshot,
} from './policy.js';
import { sameEnvironmentScope, type SessionEnvironmentReference } from './reference.js';
import type { BuildOutcome, BuildState, BuildTrigger } from './sqlite-schema.js';
import {
  isTerminal,
  parseBuildInput,
  withStage,
  type BuildInputRecord,
  type BuildRow,
  type BuildStore,
} from './store.js';

/**
 * The environment build coordinator (plan "Build admission and execution"). One
 * instance per environment, inside its `EnvironmentBuild` Durable Object. It
 * owns admission, deduplication, deadlines, the alarm-driven execution state,
 * publication and cleanup. Every provider call happens outside any storage
 * transaction, and every transition re-checks the state it expects, because
 * RPCs from the builder and the Sandbox DO interleave with alarm work.
 */

export type CoordinatorEnvironment = {
  reference(environmentId: string): Promise<EnvironmentReference | null>;
  buildInput(environmentId: string): Promise<ProfileBuildInput | null>;
  actorAccess(
    owner: EnvironmentReference['owner'],
    userId: string
  ): Promise<EnvironmentActorAccess>;
  gitSource(input: {
    reference: SessionEnvironmentReference;
    repoFullName: string;
    actorUserId: string;
  }): Promise<BuilderGitSource>;
  /** Owner-level container concurrency, the limit sessions use. */
  capacity(
    owner: EnvironmentReference['owner'],
    sandboxId: string,
    actorUserId: string
  ): Promise<'ok' | 'limit_reached'>;
};

export type CoordinatorDeps = {
  now(): number;
  uuid(): string;
  store: BuildStore;
  /** Transactional write of several store calls. */
  transaction<T>(write: () => T): T;
  /** Set the DO alarm no later than `at`. */
  armAlarm(at: number): Promise<void>;
  environment: CoordinatorEnvironment;
  provider: BuilderProvider;
  /** The builder's control base URL for `buildId`, or null when the Worker URL is unknown. */
  runnerUrl(environmentId: string, buildId: string): string | null;
  /** The signed runner credential bound to this build and allocation. */
  runnerCredential(claims: {
    environmentId: string;
    buildId: string;
    allocationId: string;
  }): Promise<string>;
  /** True when `credential` is this build and allocation's derived credential. */
  runnerCredentialMatches(
    claims: { environmentId: string; buildId: string; allocationId: string },
    credential: string
  ): Promise<boolean>;
  decryptSecrets(encrypted: Record<string, unknown>): Record<string, string>;
  billingInput(input: {
    owner: EnvironmentReference['owner'];
    actorUserId: string;
    sandboxId: string;
    buildId: string;
  }): SandboxBillingInput;
  /** The builder container DO name of this environment (`builderSandboxId`). */
  builderSandboxId: string;
  /** Null when snapshot builds can run for this owner; otherwise why not. */
  unsupportedReason(owner: EnvironmentReference['owner']): string | null;
  log(message: string, fields: Record<string, string | number | boolean | null | undefined>): void;
};

export type RunnerAuth = {
  environmentId: string;
  buildId: string;
  allocationId: string;
  credential: string;
};

export type RunnerRefusal = { refused: 'unauthorized' | 'gone' | 'unavailable' };

export type SnapshotAdmission =
  | { status: 'admitted' | 'active'; buildId: string }
  | {
      status: 'skipped';
      reason:
        | 'environment_deleted'
        | 'revision_superseded'
        | 'build_in_progress'
        | 'cleanup_pending'
        | 'backoff'
        | 'container_limit_reached'
        | 'unsupported'
        | 'unavailable';
      retryAt?: number;
    }
  | { status: 'not_needed' };

export type SnapshotResolution = {
  snapshot: {
    snapshotId: string;
    baseImage: string;
    revision: number;
    capturedAt: number;
    buildId: string;
    stale: 'revision' | 'age' | null;
  } | null;
  /** Why no snapshot was selected, when none was. */
  reason:
    | 'eligible'
    | 'missing'
    | 'scope_mismatch'
    | 'incompatible'
    | 'newer_than_session'
    | 'expired'
    | 'deleted'
    | 'unsupported';
  admission: SnapshotAdmission;
};

const ACTIVE_RUNNER_STATES: readonly BuildState[] = ['preparing'];
const CAPTURE_POLL_MS = 15_000;
const LEASE_RENEW_INTERVAL_MS = 60_000;

export class EnvironmentBuildCoordinator {
  private lastLeaseRenewalAt = 0;

  constructor(
    private readonly environmentId: string,
    private readonly deps: CoordinatorDeps
  ) {}

  // --- admission -------------------------------------------------------------

  async requestBuild(request: {
    owner: EnvironmentReference['owner'];
    expectedRevision: number;
    requestId: string;
    trigger: BuildTrigger;
    actorUserId: string;
  }): Promise<EnvironmentBuildRequestResult> {
    const { store } = this.deps;
    store.bindEnvironment(this.environmentId);
    if (this.deps.unsupportedReason(request.owner) !== null) {
      return { status: 'rejected', reason: 'unsupported_provider' };
    }
    if (store.environment()?.deletedAt != null) return { status: 'rejected', reason: 'not_found' };
    const replay = store.buildByRequest(request.requestId);
    if (replay !== null) return { status: 'accepted', buildId: replay.id, created: false };
    const active = store.activeBuild();
    if (active !== null) {
      if (active.state === 'stopping') {
        return { status: 'conflict', reason: 'cleanup_pending', buildId: active.id };
      }
      if (active.revision === request.expectedRevision) {
        return { status: 'accepted', buildId: active.id, created: false };
      }
      return { status: 'conflict', reason: 'build_in_progress', buildId: active.id };
    }
    const reference = await this.deps.environment.reference(this.environmentId);
    if (reference === null) {
      store.markDeleted(this.deps.now());
      return { status: 'rejected', reason: 'not_found' };
    }
    if (reference.configurationRevision !== request.expectedRevision) {
      return { status: 'conflict', reason: 'revision_changed', buildId: null };
    }
    const sandboxId = this.deps.builderSandboxId;
    if (
      (await this.deps.environment.capacity(reference.owner, sandboxId, request.actorUserId)) ===
      'limit_reached'
    ) {
      return { status: 'rejected', reason: 'container_limit_reached' };
    }
    const input = await this.deps.environment.buildInput(this.environmentId);
    if (input === null) {
      store.markDeleted(this.deps.now());
      return { status: 'rejected', reason: 'not_found' };
    }
    if (input.reference.configurationRevision !== request.expectedRevision) {
      return { status: 'conflict', reason: 'revision_changed', buildId: null };
    }
    const buildId = await this.admit(
      input,
      request.requestId,
      request.trigger,
      request.actorUserId
    );
    if (buildId === null) {
      // Another request admitted a build between the read and the insert.
      const raced = store.activeBuild();
      return raced !== null && raced.revision === request.expectedRevision
        ? { status: 'accepted', buildId: raced.id, created: false }
        : { status: 'conflict', reason: 'build_in_progress', buildId: raced?.id ?? null };
    }
    return { status: 'accepted', buildId, created: true };
  }

  /**
   * Persist a queued build and its alarm before acknowledging (plan: "The build
   * coordinator commits the queued record and its next alarm before
   * acknowledging the request"). Returns null when another build became active.
   */
  private async admit(
    input: ProfileBuildInput,
    requestId: string,
    trigger: BuildTrigger,
    actorUserId: string
  ): Promise<string | null> {
    const now = this.deps.now();
    const buildId = this.deps.uuid();
    const record: BuildInputRecord = {
      reference: input.reference,
      repoFullName: input.repoFullName,
      commands: input.commands,
      plainVars: input.plainVars,
    };
    const runtimeRelease = await this.deps.provider.runtimeReleaseId();
    const admitted = this.deps.transaction(() => {
      if (this.deps.store.activeBuild() !== null) return false;
      this.deps.store.insertBuild({
        id: buildId,
        request_id: requestId,
        revision: input.reference.configurationRevision,
        trigger,
        actor_user_id: actorUserId,
        input: JSON.stringify(record),
        encrypted_secrets: JSON.stringify(input.encryptedSecrets),
        instance: builderInstance(input.commands),
        runtime_release: runtimeRelease,
        state: 'queued',
        cleanup_attempts: 0,
        log_seq: 0,
        log_bytes: 0,
        log_truncated: false,
        stage_times: JSON.stringify({ queued: now }),
        created_at: now,
        deadline_at: now + BUILD_DEADLINE_MS,
      });
      if (trigger === 'session') {
        this.deps.store.recordAutoAdmitted(input.reference.configurationRevision, now);
      }
      return true;
    });
    if (!admitted) return null;
    await this.deps.armAlarm(now);
    this.deps.log('Environment build admitted', {
      environmentId: this.environmentId,
      buildId,
      revision: input.reference.configurationRevision,
      trigger,
    });
    return buildId;
  }

  /**
   * Session launch lookup (plan "Session launch"). It reads snapshot metadata and
   * may admit one background build; it never waits for build execution.
   */
  async resolveSnapshot(request: {
    reference: SessionEnvironmentReference;
    actorUserId: string;
  }): Promise<SnapshotResolution> {
    if (this.deps.unsupportedReason(request.reference.owner) !== null) {
      return {
        snapshot: null,
        reason: 'unsupported',
        admission: { status: 'skipped', reason: 'unsupported' },
      };
    }
    const { store } = this.deps;
    store.bindEnvironment(this.environmentId);
    const now = this.deps.now();
    if (store.environment()?.deletedAt != null) {
      return {
        snapshot: null,
        reason: 'deleted',
        admission: { status: 'skipped', reason: 'environment_deleted' },
      };
    }
    const published = store.published();
    const current = await this.compatibility();
    const eligibility = snapshotEligibility(published, request.reference, now, current);
    const snapshot =
      eligibility.eligible && published !== null
        ? {
            snapshotId: published.snapshotId,
            baseImage: published.baseImage,
            revision: published.revision,
            capturedAt: published.capturedAt,
            buildId: published.buildId,
            stale: eligibility.stale ? eligibility.staleReason : null,
          }
        : null;
    const reason = eligibility.eligible ? 'eligible' : eligibility.reason;
    const admission = replacementNeeded(
      published,
      request.reference.configurationRevision,
      now,
      current
    )
      ? await this.admitAutomatic(request.reference, request.actorUserId)
      : ({ status: 'not_needed' } as const);
    return { snapshot, reason, admission };
  }

  private async admitAutomatic(
    reference: SessionEnvironmentReference,
    actorUserId: string
  ): Promise<SnapshotAdmission> {
    const { store } = this.deps;
    if (this.deps.unsupportedReason(reference.owner) !== null) {
      return { status: 'skipped', reason: 'unsupported' };
    }
    const active = store.activeBuild();
    if (active !== null) {
      if (active.state === 'stopping') return { status: 'skipped', reason: 'cleanup_pending' };
      return active.revision === reference.configurationRevision
        ? { status: 'active', buildId: active.id }
        : { status: 'skipped', reason: 'build_in_progress' };
    }
    const backoff = automaticAdmission(
      store.autoAttempt(reference.configurationRevision),
      this.deps.now()
    );
    if (!backoff.admit) return { status: 'skipped', reason: 'backoff', retryAt: backoff.retryAt };
    const current = await this.deps.environment.reference(this.environmentId);
    if (current === null) {
      store.markDeleted(this.deps.now());
      return { status: 'skipped', reason: 'environment_deleted' };
    }
    // Only the environment's current revision is ever built.
    if (
      current.configurationRevision !== reference.configurationRevision ||
      !sameEnvironmentScope(current, reference)
    ) {
      return { status: 'skipped', reason: 'revision_superseded' };
    }
    const sandboxId = this.deps.builderSandboxId;
    if (
      (await this.deps.environment.capacity(current.owner, sandboxId, actorUserId)) ===
      'limit_reached'
    ) {
      return { status: 'skipped', reason: 'container_limit_reached' };
    }
    const input = await this.deps.environment.buildInput(this.environmentId);
    if (
      input === null ||
      input.reference.configurationRevision !== reference.configurationRevision
    ) {
      return { status: 'skipped', reason: 'revision_superseded' };
    }
    const buildId = await this.admit(
      input,
      `session:${reference.configurationRevision}:${this.deps.uuid()}`,
      'session',
      actorUserId
    );
    if (buildId === null) {
      const raced = store.activeBuild();
      return raced !== null && raced.revision === reference.configurationRevision
        ? { status: 'active', buildId: raced.id }
        : { status: 'skipped', reason: 'build_in_progress' };
    }
    return { status: 'admitted', buildId };
  }

  // --- reads -----------------------------------------------------------------

  /** The image and runtime ABI a session would start with now. */
  private async compatibility(): Promise<SnapshotCompatibility> {
    return {
      baseImage: await this.deps.provider.currentImage(this.deps.builderSandboxId),
      runtimeAbi: RUNTIME_BASE_ABI,
      runtimeMode:
        (await this.deps.provider.runtimeReleaseId()) === null ? 'preinstalled' : 'downloaded',
    };
  }

  async status(
    currentRevision: number,
    owner: EnvironmentReference['owner']
  ): Promise<EnvironmentBuildStatus> {
    const { store } = this.deps;
    const now = this.deps.now();
    const current = await this.compatibility();
    const active = store.activeBuild();
    const latest = store.latestTerminal();
    const published = store.published();
    const attempt = store.autoAttempt(currentRevision);
    const backoff = automaticAdmission(attempt, now);
    const unsupported = this.deps.unsupportedReason(owner);
    return {
      environmentId: this.environmentId,
      supported: unsupported === null,
      unsupportedReason: unsupported,
      configurationRevision: currentRevision,
      activeBuild: active === null ? null : summarize(active),
      latestBuild: latest === null ? null : summarize(latest),
      published:
        published === null ? null : summarizeSnapshot(published, currentRevision, now, current),
      automaticBackoff:
        attempt !== null && attempt.failures > 0 && !backoff.admit
          ? {
              revision: currentRevision,
              failures: attempt.failures,
              nextAttemptAt: backoff.retryAt,
            }
          : null,
      sessionPreparationBudgetMs: SESSION_PREPARATION_BUDGET_MS,
    };
  }

  logs(buildId: string, cursor: number | undefined, limit: number): EnvironmentBuildLogs | null {
    const build = this.deps.store.build(buildId);
    if (build === null) return null;
    const lines =
      cursor === undefined
        ? this.deps.store.readRecentLogs(buildId, limit)
        : this.deps.store.readLogs(buildId, cursor, limit);
    const nextCursor =
      lines.length === 0 ? (cursor ?? 0) : (lines[lines.length - 1]?.seq ?? cursor ?? 0);
    return {
      buildId,
      lines,
      nextCursor,
      truncated: build.log_truncated,
      complete: isTerminal(build.state) && nextCursor >= build.log_seq,
    };
  }

  // --- control ---------------------------------------------------------------

  async cancel(buildId: string): Promise<EnvironmentBuildCancelResult> {
    const now = this.deps.now();
    const queued = this.deps.store.transition(buildId, ['queued'], {
      state: 'canceled',
      outcome: 'canceled',
      encrypted_secrets: null,
      finished_at: now,
    });
    if (queued !== null) return { status: 'canceled' };
    const stopping = this.beginStopping(
      buildId,
      ['preparing', 'capturing', 'publishing'],
      'canceled',
      {
        reason: 'canceled',
      }
    );
    if (stopping === null) return { status: 'not_active' };
    await this.deps.armAlarm(now);
    return { status: 'canceling' };
  }

  /**
   * Environment deletion: stop admission at once and stop an active build. Only
   * PostgreSQL decides that the environment is gone; a notice for an existing
   * environment changes nothing.
   */
  async environmentDeleted(): Promise<void> {
    const { store } = this.deps;
    store.bindEnvironment(this.environmentId);
    if ((await this.deps.environment.reference(this.environmentId)) !== null) return;
    store.markDeleted(this.deps.now());
    const active = store.activeBuild();
    if (active === null) return;
    if (active.state === 'queued') {
      store.transition(active.id, ['queued'], {
        state: 'obsolete',
        outcome: 'obsolete',
        failure_reason: 'environment_deleted',
        encrypted_secrets: null,
        finished_at: this.deps.now(),
      });
      return;
    }
    this.beginStopping(active.id, ['preparing', 'capturing', 'publishing'], 'obsolete', {
      reason: 'environment_deleted',
    });
    await this.deps.armAlarm(this.deps.now());
  }

  // --- runner callbacks ------------------------------------------------------

  private async authorizeRunner(
    auth: RunnerAuth,
    states: readonly BuildState[]
  ): Promise<BuildRow | RunnerRefusal> {
    if (auth.environmentId !== this.environmentId) return { refused: 'unauthorized' };
    const build = this.deps.store.build(auth.buildId);
    if (build === null || build.allocation_id !== auth.allocationId) {
      return { refused: 'unauthorized' };
    }
    if (!(await this.deps.runnerCredentialMatches(auth, auth.credential))) {
      return { refused: 'unauthorized' };
    }
    if (!states.includes(build.state)) return { refused: 'gone' };
    return build;
  }

  /** The builder's inputs. Secrets are decrypted only into this reply. */
  async runnerInput(auth: RunnerAuth): Promise<EnvironmentBuildInput | RunnerRefusal> {
    const build = await this.authorizeRunner(auth, ACTIVE_RUNNER_STATES);
    if ('refused' in build) return build;
    const input = parseBuildInput(build);
    const git = await this.deps.environment.gitSource({
      reference: input.reference,
      repoFullName: input.repoFullName,
      actorUserId: build.actor_user_id,
    });
    if (!git.ok) {
      if (git.reason === 'unavailable') return { refused: 'unavailable' };
      await this.failRunning(build.id, 'repository_unauthorized');
      return { refused: 'gone' };
    }
    let secrets: Record<string, string>;
    try {
      secrets =
        build.encrypted_secrets === null
          ? {}
          : this.deps.decryptSecrets(
              JSON.parse(build.encrypted_secrets) as Record<string, unknown>
            );
    } catch {
      await this.failRunning(build.id, 'input_unavailable', 'secrets could not be decrypted');
      return { refused: 'gone' };
    }
    return {
      environmentId: this.environmentId,
      buildId: build.id,
      allocationId: auth.allocationId,
      git: git.git,
      directory: ENVIRONMENT_BUILD_WORKSPACE,
      commands: input.commands,
      env: { ...input.plainVars, ...secrets },
      secretKeys: Object.keys(secrets),
      deadlineAt: build.deadline_at,
    };
  }

  async runnerEvents(
    auth: RunnerAuth,
    events: EnvironmentBuildEvents
  ): Promise<EnvironmentBuildEventsReply | RunnerRefusal> {
    const build = await this.authorizeRunner(auth, ['preparing', 'stopping']);
    if ('refused' in build) return build;
    if (build.state === 'stopping') return { action: 'cancel' };
    const now = this.deps.now();
    const fresh = build.last_event_sequence === null || events.sequence > build.last_event_sequence;
    this.deps.transaction(() => {
      if (fresh && events.logs !== undefined && events.logs.length > 0) {
        this.deps.store.appendLogs(build, events.logs);
      }
      this.deps.store.update(build.id, {
        last_heartbeat_at: now,
        ...(fresh ? { last_event_sequence: events.sequence } : {}),
        ...(fresh && events.step !== undefined ? { runner_step: events.step } : {}),
      });
    });
    if (now - this.lastLeaseRenewalAt >= LEASE_RENEW_INTERVAL_MS) {
      this.lastLeaseRenewalAt = now;
      await this.deps.provider.renewLease(this.allocationOf(build)).catch(() => undefined);
    }
    return { action: 'continue' };
  }

  async runnerResult(
    auth: RunnerAuth,
    result: EnvironmentBuildResult
  ): Promise<'ok' | RunnerRefusal> {
    const build = await this.authorizeRunner(auth, [
      'preparing',
      'capturing',
      'publishing',
      'stopping',
    ]);
    if ('refused' in build) return build;
    // A replayed result after the first was applied is acknowledged once more.
    if (build.state !== 'preparing') return 'ok';
    const now = this.deps.now();
    if (result.outcome === 'ready') {
      const captured = this.deps.store.transition(build.id, ['preparing'], {
        state: 'capturing',
        source_commit: result.commit,
        source_branch: result.branch,
        setup_duration_ms: result.setupDurationMs,
        capture_id: this.deps.uuid(),
        last_heartbeat_at: now,
        stage_times: withStage(build, 'capturing', now),
      });
      if (captured !== null) await this.deps.armAlarm(now);
      return 'ok';
    }
    await this.failRunning(build.id, result.reason, result.detail);
    return 'ok';
  }

  // --- execution ---------------------------------------------------------------

  /** One alarm pass: advance the active build, retry due cleanups, prune history. */
  async alarm(): Promise<void> {
    const { store } = this.deps;
    const now = this.deps.now();
    const active = store.activeBuild();
    if (active !== null) await this.advance(active);
    for (const stopping of store.dueCleanups(this.deps.now())) {
      if (stopping.id !== active?.id) await this.advanceStopping(stopping);
    }
    store.prune(now);
    const next = this.nextAlarm();
    if (next !== null) await this.deps.armAlarm(next);
  }

  private nextAlarm(): number | null {
    const now = this.deps.now();
    const active = this.deps.store.activeBuild();
    if (active === null) return null;
    switch (active.state) {
      case 'queued':
        return Math.min(now + PREPARING_TICK_MS, active.deadline_at);
      case 'publishing':
        return now;
      case 'preparing':
        return Math.min(now + PREPARING_TICK_MS, active.deadline_at);
      case 'capturing':
        return now + CAPTURE_POLL_MS;
      case 'stopping':
        return active.next_cleanup_at ?? now;
      default:
        return null;
    }
  }

  private async advance(build: BuildRow): Promise<void> {
    if (
      build.state !== 'stopping' &&
      this.deps.unsupportedReason(parseBuildInput(build).reference.owner) !== null
    ) {
      if (build.state === 'queued') {
        this.terminalWithoutAllocation(build, 'obsolete', 'snapshots_disabled');
      } else {
        this.beginStopping(build.id, [build.state], 'obsolete', { reason: 'snapshots_disabled' });
      }
      return;
    }
    switch (build.state) {
      case 'queued':
        return this.advanceQueued(build);
      case 'preparing':
        return this.advancePreparing(build);
      case 'capturing':
        return this.advanceCapturing(build);
      case 'publishing':
        return this.advancePublishing(build);
      case 'stopping':
        return this.advanceStopping(build);
      default:
        return;
    }
  }

  private terminalWithoutAllocation(
    build: BuildRow,
    outcome: BuildOutcome,
    reason: string,
    detail?: string
  ): void {
    const now = this.deps.now();
    const done = this.deps.store.transition(build.id, ['queued'], {
      state: outcome,
      outcome,
      failure_reason: reason,
      failure_detail: detail ?? null,
      encrypted_secrets: null,
      finished_at: now,
    });
    if (done !== null) this.recordAutomaticOutcome(done);
    this.deps.log('Environment build ended before allocation', {
      environmentId: this.environmentId,
      buildId: build.id,
      outcome,
      reason,
    });
  }

  /** Execution order steps 1 to 4: recheck, persist the allocation intent, start the builder. */
  private async advanceQueued(build: BuildRow): Promise<void> {
    const now = this.deps.now();
    if (now >= build.deadline_at)
      return this.terminalWithoutAllocation(build, 'failed', 'deadline');
    if (this.deps.store.environment()?.deletedAt != null) {
      return this.terminalWithoutAllocation(build, 'obsolete', 'environment_deleted');
    }
    const input = parseBuildInput(build);
    const reference = await this.deps.environment.reference(this.environmentId);
    if (reference === null) {
      this.deps.store.markDeleted(now);
      return this.terminalWithoutAllocation(build, 'obsolete', 'environment_deleted');
    }
    if (
      reference.configurationRevision !== build.revision ||
      !sameEnvironmentScope(reference, input.reference)
    ) {
      return this.terminalWithoutAllocation(build, 'obsolete', 'configuration_changed');
    }
    const access = await this.deps.environment.actorAccess(reference.owner, build.actor_user_id);
    if (access === 'none' || (build.trigger === 'manual' && access !== 'manage')) {
      return this.terminalWithoutAllocation(build, 'failed', 'actor_unauthorized');
    }
    const sandboxId = this.deps.builderSandboxId;
    if (
      (await this.deps.environment.capacity(reference.owner, sandboxId, build.actor_user_id)) ===
      'limit_reached'
    ) {
      return this.terminalWithoutAllocation(build, 'failed', 'container_limit_reached');
    }
    const git = await this.deps.environment.gitSource({
      reference: input.reference,
      repoFullName: input.repoFullName,
      actorUserId: build.actor_user_id,
    });
    if (!git.ok) {
      if (git.reason === 'unavailable') return; // The next alarm retries within the deadline.
      return this.terminalWithoutAllocation(build, 'failed', 'repository_unauthorized');
    }
    const allocation: BuilderAllocation = {
      sandboxId,
      allocationId: this.deps.uuid(),
      instance: build.instance as BuilderAllocation['instance'],
    };
    // Plan step 2: the allocation intent is durable before the provider request.
    const preparing = this.deps.store.transition(build.id, ['queued'], {
      state: 'preparing',
      allocation_id: allocation.allocationId,
      stage_times: withStage(build, 'preparing', this.deps.now()),
    });
    if (preparing === null) return;
    await this.launch(preparing);
  }

  private async launch(build: BuildRow): Promise<void> {
    const allocation = this.allocationOf(build);
    const url = this.deps.runnerUrl(this.environmentId, build.id);
    if (url === null) {
      this.beginStopping(build.id, ['preparing'], 'failed', { reason: 'builder_start_failed' });
      return;
    }
    const input = parseBuildInput(build);
    try {
      await this.deps.provider.admitBilling(
        allocation,
        this.deps.billingInput({
          owner: input.reference.owner,
          actorUserId: build.actor_user_id,
          sandboxId: allocation.sandboxId,
          buildId: build.id,
        })
      );
    } catch (error) {
      const reason =
        error instanceof ProviderCreationError && error.code === 'insufficient_credits'
          ? 'billing_blocked'
          : 'billing_unavailable';
      this.beginStopping(build.id, ['preparing'], 'failed', { reason });
      return;
    }
    if (this.deps.store.build(build.id)?.state !== 'preparing') return;
    const credential = await this.deps.runnerCredential({
      environmentId: this.environmentId,
      buildId: build.id,
      allocationId: allocation.allocationId,
    });
    try {
      await this.deps.provider.launch(allocation, {
        runner: { url, credential },
        deadlineAt: build.deadline_at,
      });
    } catch {
      const reason = 'builder_start_failed' as const;
      this.deps.log('Environment builder start failed', {
        environmentId: this.environmentId,
        buildId: build.id,
        reason,
      });
      this.beginStopping(build.id, ['preparing'], 'failed', { reason });
      return;
    }
    const now = this.deps.now();
    this.lastLeaseRenewalAt = now;
    this.deps.store.transition(build.id, ['preparing'], {
      launched_at: now,
      stage_times: withStage(build, 'launched', now),
    });
  }

  private async advancePreparing(build: BuildRow): Promise<void> {
    const now = this.deps.now();
    if (now >= build.deadline_at) {
      this.beginStopping(build.id, ['preparing'], 'failed', { reason: 'deadline' });
      return;
    }
    if (this.deps.store.environment()?.deletedAt != null) {
      this.beginStopping(build.id, ['preparing'], 'obsolete', { reason: 'environment_deleted' });
      return;
    }
    if (build.launched_at === null) {
      // A restart interrupted the start; the builder launch is idempotent per allocation.
      await this.launch(build);
      return;
    }
    const reference = await this.deps.environment.reference(this.environmentId);
    if (reference === null) {
      this.deps.store.markDeleted(now);
      this.beginStopping(build.id, ['preparing'], 'obsolete', { reason: 'environment_deleted' });
      return;
    }
    if (reference.configurationRevision !== build.revision) {
      this.beginStopping(build.id, ['preparing'], 'obsolete', { reason: 'configuration_changed' });
      return;
    }
    const lastReport = build.last_heartbeat_at;
    if (
      (lastReport === null && now - build.launched_at >= BUILDER_FIRST_REPORT_MS) ||
      (lastReport !== null && now - lastReport >= BUILDER_REPORT_LOSS_MS)
    ) {
      this.beginStopping(build.id, ['preparing'], 'failed', { reason: 'builder_lost' });
      return;
    }
    if (now - this.lastLeaseRenewalAt >= LEASE_RENEW_INTERVAL_MS) {
      this.lastLeaseRenewalAt = now;
      await this.deps.provider.renewLease(this.allocationOf(build)).catch(() => undefined);
    }
  }

  /** Plan step 8: capture under the persisted id; a lost reply is read back, never retaken. */
  private async advanceCapturing(build: BuildRow): Promise<void> {
    if (this.deps.now() >= build.deadline_at) {
      this.beginStopping(build.id, ['capturing'], 'failed', { reason: 'deadline' });
      return;
    }
    if (build.capture_id === null) {
      this.beginStopping(build.id, ['capturing'], 'failed', { reason: 'capture_failed' });
      return;
    }
    await this.deps.provider.renewLease(this.allocationOf(build)).catch(() => undefined);
    let result;
    try {
      result = await this.deps.provider.capture(this.allocationOf(build), build.capture_id);
    } catch {
      // The reply was lost; the next pass reads the stored result by capture id.
      return;
    }
    if (result.status === 'in_progress') return;
    if (result.status === 'failed') {
      this.beginStopping(build.id, ['capturing'], 'failed', {
        reason: result.reason === 'uncertain' ? 'capture_uncertain' : 'capture_failed',
      });
      return;
    }
    const now = this.deps.now();
    const publishing = this.deps.store.transition(build.id, ['capturing'], {
      state: 'publishing',
      capture_result: JSON.stringify(result),
      stage_times: withStage(build, 'publishing', now),
    });
    if (publishing !== null) await this.advancePublishing(publishing);
  }

  /** Plan steps 9 and 10: recheck everything, then replace the descriptor atomically. */
  private async advancePublishing(build: BuildRow): Promise<void> {
    const now = this.deps.now();
    if (this.deps.store.environment()?.deletedAt != null) {
      this.beginStopping(build.id, ['publishing'], 'obsolete', { reason: 'environment_deleted' });
      return;
    }
    const input = parseBuildInput(build);
    const reference = await this.deps.environment.reference(this.environmentId);
    if (reference === null) {
      this.deps.store.markDeleted(now);
      this.beginStopping(build.id, ['publishing'], 'obsolete', { reason: 'environment_deleted' });
      return;
    }
    if (
      reference.configurationRevision !== build.revision ||
      !sameEnvironmentScope(reference, input.reference)
    ) {
      this.beginStopping(build.id, ['publishing'], 'obsolete', { reason: 'configuration_changed' });
      return;
    }
    const access = await this.deps.environment.actorAccess(reference.owner, build.actor_user_id);
    if (access === 'none' || (build.trigger === 'manual' && access !== 'manage')) {
      this.beginStopping(build.id, ['publishing'], 'failed', { reason: 'actor_unauthorized' });
      return;
    }
    const git = await this.deps.environment.gitSource({
      reference: input.reference,
      repoFullName: input.repoFullName,
      actorUserId: build.actor_user_id,
    });
    if (!git.ok) {
      if (git.reason === 'unavailable' && now < build.deadline_at) return;
      this.beginStopping(build.id, ['publishing'], 'failed', { reason: 'repository_unauthorized' });
      return;
    }
    const capture = parseCaptureResult(build.capture_result);
    if (capture === null || build.source_commit === null || build.source_branch === null) {
      this.beginStopping(build.id, ['publishing'], 'failed', { reason: 'capture_failed' });
      return;
    }
    const descriptor: PublishedSnapshot = {
      buildId: build.id,
      environmentId: this.environmentId,
      owner: input.reference.owner,
      revision: build.revision,
      repository: input.reference.repository,
      sourceCommit: build.source_commit,
      sourceBranch: build.source_branch,
      provider: 'cloudflare-containers',
      baseImage: capture.baseImage,
      runtimeAbi: RUNTIME_BASE_ABI,
      runtimeRelease: build.runtime_release,
      builderInstance: build.instance,
      snapshotId: capture.snapshotId,
      ...(capture.size === undefined ? {} : { size: capture.size }),
      capturedAt: capture.capturedAt,
      publishedAt: now,
      setupDurationMs: build.setup_duration_ms ?? 0,
    };
    const published = this.deps.transaction(() => {
      const stopping = this.beginStopping(build.id, ['publishing'], 'succeeded', {});
      if (stopping === null) return false;
      this.deps.store.publish(descriptor);
      return true;
    });
    if (published) {
      this.deps.log('Environment snapshot published', {
        environmentId: this.environmentId,
        buildId: build.id,
        revision: build.revision,
        setupDurationMs: build.setup_duration_ms ?? 0,
      });
    }
  }

  /** Plan step 11: stop the exact builder allocation; retain evidence until confirmed. */
  private async advanceStopping(build: BuildRow): Promise<void> {
    const now = this.deps.now();
    if (build.next_cleanup_at !== null && build.next_cleanup_at > now) return;
    if (build.allocation_id === null) {
      this.finalize(build);
      return;
    }
    let result: 'terminal' | 'retryable';
    try {
      result = await this.deps.provider.stop(this.allocationOf(build));
    } catch {
      result = 'retryable';
    }
    if (result === 'terminal') {
      this.finalize(build);
      return;
    }
    const attempts = build.cleanup_attempts + 1;
    this.deps.store.transition(build.id, ['stopping'], {
      cleanup_attempts: attempts,
      next_cleanup_at: now + cleanupRetryDelay(attempts),
      cleanup_error: attempts >= CLEANUP_ATTEMPTS_BEFORE_FAILURE ? 'stop_unconfirmed' : null,
    });
  }

  private finalize(build: BuildRow): void {
    const outcome = build.outcome ?? 'failed';
    const done = this.deps.store.transition(build.id, ['stopping'], {
      state: outcome,
      encrypted_secrets: null,
      cleanup_error: null,
      next_cleanup_at: null,
      finished_at: this.deps.now(),
      stage_times: withStage(build, 'finished', this.deps.now()),
    });
    if (done === null) return;
    this.recordAutomaticOutcome(done);
    this.deps.log('Environment build finished', {
      environmentId: this.environmentId,
      buildId: build.id,
      outcome,
      reason: build.failure_reason,
    });
  }

  private recordAutomaticOutcome(build: BuildRow): void {
    if (build.state === 'succeeded') {
      this.deps.store.recordAutoSuccess(build.revision);
      return;
    }
    if (
      build.trigger === 'session' &&
      build.state === 'failed' &&
      build.failure_reason !== null &&
      COUNTED_FAILURE_REASONS.has(build.failure_reason)
    ) {
      this.deps.store.recordAutoFailure(build.revision, this.deps.now());
    }
  }

  /**
   * Persist cleanup intent with the intended outcome (plan: "Persist cleanup
   * intent before stopping"). A failure reason is written only with a failed
   * or obsolete outcome.
   */
  private beginStopping(
    buildId: string,
    from: readonly BuildState[],
    outcome: BuildOutcome,
    failure: { reason?: string; detail?: string }
  ): BuildRow | null {
    const now = this.deps.now();
    const current = this.deps.store.build(buildId);
    if (current === null) return null;
    return this.deps.store.transition(buildId, from, {
      state: 'stopping',
      outcome,
      ...(failure.reason === undefined ? {} : { failure_reason: failure.reason }),
      ...(failure.detail === undefined ? {} : { failure_detail: failure.detail }),
      next_cleanup_at: null,
      stage_times: withStage(current, 'stopping', now),
    });
  }

  private allocationOf(build: BuildRow): BuilderAllocation {
    if (build.allocation_id === null) throw new Error('Build has no allocation');
    return {
      sandboxId: this.deps.builderSandboxId,
      allocationId: build.allocation_id,
      instance: build.instance as BuilderAllocation['instance'],
    };
  }

  private async failRunning(buildId: string, reason: string, detail?: string): Promise<void> {
    const stopping = this.beginStopping(buildId, ['preparing'], 'failed', {
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
    if (stopping !== null) await this.deps.armAlarm(this.deps.now());
  }
}

type StoredCapture = {
  snapshotId: string;
  size?: number;
  capturedAt: number;
  baseImage: string;
};

function parseCaptureResult(value: string | null): StoredCapture | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCapture> & { status?: string };
    if (
      parsed.status !== 'stored' ||
      typeof parsed.snapshotId !== 'string' ||
      typeof parsed.capturedAt !== 'number' ||
      typeof parsed.baseImage !== 'string'
    ) {
      return null;
    }
    return {
      snapshotId: parsed.snapshotId,
      capturedAt: parsed.capturedAt,
      baseImage: parsed.baseImage,
      ...(typeof parsed.size === 'number' ? { size: parsed.size } : {}),
    };
  } catch {
    return null;
  }
}

function summarize(build: BuildRow): EnvironmentBuildSummary {
  const cleanup =
    build.allocation_id === null
      ? 'not_started'
      : build.state === 'stopping'
        ? build.cleanup_error === null
          ? 'pending'
          : 'failing'
        : isTerminal(build.state)
          ? 'confirmed'
          : 'not_started';
  const step = build.runner_step;
  return {
    buildId: build.id,
    revision: build.revision,
    trigger: build.trigger,
    state: build.state,
    outcome: build.outcome ?? null,
    step: step === 'clone' || step === 'setup' || step === 'cleanup' ? step : null,
    failureReason: build.failure_reason,
    failureDetail: build.failure_detail,
    sourceCommit: build.source_commit,
    sourceBranch: build.source_branch,
    setupDurationMs: build.setup_duration_ms,
    createdAt: build.created_at,
    finishedAt: build.finished_at,
    cleanup,
    logTruncated: build.log_truncated,
  };
}

function summarizeSnapshot(
  published: PublishedSnapshot,
  currentRevision: number,
  now: number,
  current: SnapshotCompatibility
) {
  const stale = !compatibleWith(published, current)
    ? ('image' as const)
    : published.revision < currentRevision
      ? ('revision' as const)
      : replacementNeeded(published, published.revision, now, current)
        ? ('age' as const)
        : null;
  return {
    buildId: published.buildId,
    revision: published.revision,
    sourceCommit: published.sourceCommit,
    sourceBranch: published.sourceBranch,
    capturedAt: published.capturedAt,
    size: published.size ?? null,
    setupDurationMs: published.setupDurationMs,
    stale,
    expiresAt: published.capturedAt + SNAPSHOT_ELIGIBLE_LIFETIME_MS,
  };
}
