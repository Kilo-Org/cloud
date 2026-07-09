import type {
  AgentSandbox,
  EnsureWrapperRequest,
  StopWrappersResult,
  TerminalClientResult,
  WrapperLogs,
  WrapperObservation,
  WrapperStopTarget,
} from '../protocol.js';
import type {
  Env,
  SandboxId,
  SandboxInstance,
  SessionId as ServiceSessionId,
} from '../../types.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { SandboxDeleteReason, WrapperStopReason } from '../protocol.js';
import { getSandbox } from '@cloudflare/sandbox';
import { posix } from 'node:path';
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../../core/lease.js';
import {
  generateSandboxId,
  getSandboxNamespace,
  isOrgInList,
  MANAGED_SCM_OUTBOUND_HANDLER,
} from '../../sandbox-id.js';
import { SessionService } from '../../session-service.js';
import { logger } from '../../logger.js';
import { WrapperClient, WrapperContainerClient, WrapperError } from '../../kilo/wrapper-client.js';
import {
  discoverSessionWrappers,
  findWrapperForSession,
  stopObservedWrappers,
} from '../../kilo/wrapper-manager.js';
import {
  checkDiskAndCleanBeforeSetup,
  cleanupWorkspace,
  getSessionHomePath,
  getSessionWorkspacePath,
} from '../../workspace.js';
import {
  FAST_SANDBOX_COMMAND_TIMEOUT_MS,
  logSandboxOperationTimeout,
  timedExec,
} from '../../sandbox-timeout-logging.js';
import { SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE } from '../../sandbox-recovery.js';
import { withTimeout } from '@kilocode/worker-utils';
import { WRAPPER_VERSION } from '../../shared/wrapper-version.js';
import { ExecutionError } from '../../execution/errors.js';
import { readProfileBundle, type SessionProfileBundle } from '../../session-profile.js';
import {
  logWorkspaceBackupDisabled,
  logWorkspaceBackupLifecycle,
  type WorkspaceBackupFailureCategory,
} from '../../workspace-backup-observability.js';
import {
  buildWorkspaceBackupCandidate,
  createWorkspaceBackupRecord,
  loadWorkspaceBackupRecord,
  storeWorkspaceBackupRecord,
  WORKSPACE_BACKUP_TTL_MS,
  type WorkspaceBackupCandidate,
} from '../../workspace-backup-cache.js';
import {
  isSandboxFilesystemUnusableError,
  SandboxCapacityInspectionError,
  WorkspaceCapacityAdmissionRejectedError,
  WorkspaceFilesystemPreparationError,
} from '../../workspace-errors.js';
import { TOOL_CGROUP_ENV_KEYS, type ToolCgroupEnv } from '../../shared/tool-cgroup-env.js';

const PREPARE_WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STOP_OBSERVATION_DELAYS_MS = [100, 500, 1_000];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

/**
 * `TOOL_CGROUP_*` knobs to pass through to the wrapper, gated by
 * `TOOL_CGROUP_ORG_IDS` (see MEMORY_CGROUPS_PLAN.md W4). Undefined when the
 * org isn't in the rollout list, so callers can omit the field entirely.
 */
function buildToolCgroupEnv(env: Env, orgId: string | undefined): ToolCgroupEnv | undefined {
  if (!isOrgInList(env.TOOL_CGROUP_ORG_IDS, orgId)) return undefined;
  const vars: ToolCgroupEnv = {};
  for (const key of TOOL_CGROUP_ENV_KEYS) {
    const value = env[key];
    if (value) vars[key] = value;
  }
  return vars;
}

function reportWorkspaceBackupProgress(
  onProgress: EnsureWrapperRequest['onProgress'],
  step: 'workspace_restore' | 'workspace_backup',
  message: string
): void {
  try {
    onProgress?.(step, message);
  } catch {
    return;
  }
}

export function deriveSetupEnvironment(
  profile: Pick<SessionProfileBundle, 'envVars' | 'encryptedSecrets'>,
  materializedEnvironment: Record<string, string>
): {
  variables: Record<string, string>;
  secretIdentities: Record<string, string>;
} | null {
  const encryptedSecrets = profile.encryptedSecrets ?? {};
  const variables: Record<string, string> = {};
  for (const key of Object.keys(profile.envVars ?? {})) {
    if (Object.hasOwn(encryptedSecrets, key)) continue;
    if (!Object.hasOwn(materializedEnvironment, key)) return null;
    const value = materializedEnvironment[key];
    if (value === undefined) return null;
    variables[key] = value;
  }

  const secretIdentities: Record<string, string> = {};
  for (const [key, envelope] of Object.entries(encryptedSecrets)) {
    secretIdentities[key] = JSON.stringify({
      algorithm: envelope.algorithm,
      version: envelope.version,
      encryptedData: envelope.encryptedData,
      encryptedDEK: envelope.encryptedDEK,
    });
  }
  return { variables, secretIdentities };
}

function withWorkspacePreparationTimeout<T>(operation: Promise<T>, step: string): Promise<T> {
  return withTimeout(
    operation,
    PREPARE_WORKSPACE_TIMEOUT_MS,
    `Workspace preparation timed out during ${step} after ${PREPARE_WORKSPACE_TIMEOUT_MS / 1000}s`,
    () =>
      logSandboxOperationTimeout({
        operation: `workspace.prepare:${step}`,
        timeoutMs: PREPARE_WORKSPACE_TIMEOUT_MS,
        timeoutLayer: 'outer',
      })
  );
}

export type CloudflareAgentSandboxDependencies = {
  resolveSandbox?: (sandboxId: SandboxId, options?: { sleepAfter?: number }) => SandboxInstance;
  sessionService?: SessionService;
  stopObservedWrappers?: typeof stopObservedWrappers;
  sleep?: (ms: number) => Promise<void>;
  stopObservationDelaysMs?: number[];
};

export class CloudflareAgentSandbox implements AgentSandbox {
  private readonly sessionService: SessionService;
  private readonly resolveSandbox: (
    sandboxId: SandboxId,
    options?: { sleepAfter?: number }
  ) => SandboxInstance;
  private readonly stopObserved: typeof stopObservedWrappers;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stopObservationDelaysMs: number[];
  private sandboxIdPromise?: Promise<SandboxId>;

  constructor(
    private readonly env: Env,
    private readonly metadata: SessionMetadata,
    dependencies: CloudflareAgentSandboxDependencies = {}
  ) {
    this.sessionService = dependencies.sessionService ?? new SessionService();
    this.resolveSandbox =
      dependencies.resolveSandbox ??
      ((sandboxId, options) =>
        options
          ? getSandbox(
              getSandboxNamespace(this.env, sandboxId, {
                managedScmContainment: this.metadata.workspace?.managedScmContainment === true,
              }),
              sandboxId,
              options
            )
          : getSandbox(
              getSandboxNamespace(this.env, sandboxId, {
                managedScmContainment: this.metadata.workspace?.managedScmContainment === true,
              }),
              sandboxId
            ));
    this.stopObserved = dependencies.stopObservedWrappers ?? stopObservedWrappers;
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopObservationDelaysMs =
      dependencies.stopObservationDelaysMs ?? DEFAULT_STOP_OBSERVATION_DELAYS_MS;
  }

  private resolveSandboxId(): Promise<SandboxId> {
    if (!this.sandboxIdPromise) {
      this.sandboxIdPromise = this.metadata.workspace?.sandboxId
        ? Promise.resolve(this.metadata.workspace.sandboxId)
        : generateSandboxId(
            this.env.PER_SESSION_SANDBOX_ORG_IDS,
            this.metadata.identity.orgId,
            this.metadata.identity.userId,
            this.metadata.identity.sessionId,
            this.metadata.identity.botId,
            {
              createdOnPlatform: this.metadata.identity.createdOnPlatform,
            }
          );
    }
    return this.sandboxIdPromise;
  }

  private async getSandbox(options?: { sleepAfter?: number }): Promise<SandboxInstance> {
    return this.resolveSandbox(await this.resolveSandboxId(), options);
  }

  private async workspaceHasGit(sandbox: SandboxInstance, workspacePath: string): Promise<boolean> {
    const timeoutMs = FAST_SANDBOX_COMMAND_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        timedExec(
          sandbox,
          `test -d '${workspacePath}/.git' && echo exists`,
          'execution.wrapperBootstrap.repoExists'
        ),
        timeoutMs,
        `${SANDBOX_WORKSPACE_PROBE_TIMEOUT_MESSAGE} after ${timeoutMs}ms`,
        () =>
          logSandboxOperationTimeout({
            operation: 'execution.wrapperBootstrap.repoExists',
            timeoutMs,
            timeoutLayer: 'outer',
          })
      );
      if (result.exitCode !== 0 && isSandboxFilesystemUnusableError(result.stderr)) {
        throw new SandboxCapacityInspectionError(
          'Workspace admission probe cannot run because the sandbox filesystem is unusable',
          new Error(result.stderr)
        );
      }
      return result.stdout?.includes('exists') ?? false;
    } catch (error) {
      if (isSandboxFilesystemUnusableError(error)) {
        throw new SandboxCapacityInspectionError(
          'Workspace admission probe cannot run because the sandbox filesystem is unusable',
          error
        );
      }
      throw error;
    }
  }

  private requiresPreparedDevcontainerRuntime(request: EnsureWrapperRequest): boolean {
    return (
      request.plan.workspace.metadata.workspace?.devcontainerRequested === true ||
      request.plan.workspace.metadata.devcontainer !== undefined
    );
  }

  private usesDevcontainerRuntime(): boolean {
    return (
      this.metadata.workspace?.sandboxId?.startsWith('dind-') === true ||
      this.metadata.workspace?.devcontainerRequested === true ||
      this.metadata.devcontainer !== undefined
    );
  }

  private existingWrapperSessionName(): string {
    const sessionId = this.metadata.identity.sessionId;
    return this.usesDevcontainerRuntime() ? sessionId : `${sessionId}-bootstrap`;
  }

  private backupMode(): { bucket: R2Bucket; localBucket: boolean } | null {
    const bucket = this.env.BACKUP_BUCKET;
    if (!bucket) return null;
    try {
      const hostname = new URL(this.env.WORKER_URL ?? '').hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === 'host.docker.internal'
      ) {
        return { bucket, localBucket: true };
      }
    } catch {
      logWorkspaceBackupDisabled('invalid_worker_url');
      return null;
    }
    if (
      !this.env.BACKUP_BUCKET_NAME ||
      !this.env.CLOUDFLARE_R2_ACCOUNT_ID ||
      !this.env.R2_ACCESS_KEY_ID ||
      !this.env.R2_SECRET_ACCESS_KEY
    ) {
      return null;
    }
    return { bucket, localBucket: false };
  }

  private async buildBackupCandidate(request: EnsureWrapperRequest) {
    const readyRequest = request.prepared.readyRequest;
    if (!readyRequest) return null;
    if (!isOrgInList(this.env.REPO_SNAPSHOT_ORG_IDS, request.plan.scope.orgId)) return null;
    const profile = readProfileBundle(request.plan.workspace.metadata);
    const setupEnvironment = deriveSetupEnvironment(profile, readyRequest.materialized.env);
    if (setupEnvironment === null) return null;
    const repo = readyRequest.repo;
    return buildWorkspaceBackupCandidate({
      fresh: request.plan.workspace.metadata.lifecycle.preparedAt === undefined,
      devcontainer: readyRequest.devcontainer?.requested === true,
      setupCommands: readyRequest.materialized.setupCommands,
      setupEnvironment,
      userId: request.plan.scope.userId,
      orgId: request.plan.scope.orgId,
      repository:
        repo?.kind === 'github'
          ? { type: 'github', repo: repo.repo }
          : repo
            ? { type: repo.platform === 'gitlab' ? 'gitlab' : 'git', url: repo.url }
            : undefined,
      shallow: repo?.shallow,
    });
  }

  private async cleanWorkspaceTarget(
    sandbox: SandboxInstance,
    workspacePath: string
  ): Promise<void> {
    const removal = await sandbox.exec(`rm -rf -- ${shellQuote(workspacePath)}`);
    if (removal.exitCode !== 0) {
      throw new WorkspaceFilesystemPreparationError(
        'workspace_directory',
        `Failed to remove workspace directory: ${removal.stderr || `exit code ${removal.exitCode}`}`,
        removal
      );
    }
  }

  private async prepareWorkspaceRestoreParent(
    sandbox: SandboxInstance,
    workspacePath: string
  ): Promise<void> {
    const parentPath = posix.dirname(workspacePath);
    const creation = await sandbox.exec(`mkdir -p -- ${shellQuote(parentPath)}`);
    if (creation.exitCode !== 0) {
      throw new WorkspaceFilesystemPreparationError(
        'workspace_directory',
        `Failed to create workspace parent directory: ${creation.stderr || `exit code ${creation.exitCode}`}`,
        creation
      );
    }
  }

  private async restoreWorkspaceBackup(
    sandbox: SandboxInstance,
    workspacePath: string,
    candidate: WorkspaceBackupCandidate,
    bucket: R2Bucket,
    onProgress?: EnsureWrapperRequest['onProgress']
  ): Promise<string | undefined> {
    const record = await loadWorkspaceBackupRecord(bucket, candidate);
    if (!record) return undefined;
    reportWorkspaceBackupProgress(
      onProgress,
      'workspace_restore',
      'Restoring prepared workspace...'
    );
    const startedAt = Date.now();
    logWorkspaceBackupLifecycle({ operation: 'restore', outcome: 'started' });
    let failureCategory: WorkspaceBackupFailureCategory = 'workspace_cleanup_failed';
    try {
      await this.cleanWorkspaceTarget(sandbox, workspacePath);
      failureCategory = 'workspace_parent_prepare_failed';
      await this.prepareWorkspaceRestoreParent(sandbox, workspacePath);
      failureCategory = 'backup_restore_failed';
      await sandbox.restoreBackup({ ...record.backup, dir: workspacePath });
      failureCategory = 'backup_validation_failed';
      const validation = await sandbox.exec(
        `test -d ${shellQuote(`${workspacePath}/.git`)} && test "$(git -C ${shellQuote(workspacePath)} rev-parse --verify HEAD)" = ${shellQuote(record.sourceCommit)} && test "$(git -C ${shellQuote(workspacePath)} remote get-url origin)" = ${shellQuote(candidate.canonicalRepository)}`
      );
      if (validation.exitCode !== 0) throw new Error('restored workspace validation failed');
      logWorkspaceBackupLifecycle({
        operation: 'restore',
        outcome: 'completed',
        durationMs: elapsedMs(startedAt),
      });
      return record.sourceCommit;
    } catch (error) {
      if (error instanceof WorkspaceFilesystemPreparationError) {
        logWorkspaceBackupLifecycle({
          operation: 'restore',
          outcome: 'failed',
          durationMs: elapsedMs(startedAt),
          failureCategory,
        });
        throw error;
      }
      try {
        await this.cleanWorkspaceTarget(sandbox, workspacePath);
      } catch (cleanupError) {
        logWorkspaceBackupLifecycle({
          operation: 'restore',
          outcome: 'failed',
          durationMs: elapsedMs(startedAt),
          failureCategory: 'fallback_cleanup_failed',
        });
        throw cleanupError;
      }
      logWorkspaceBackupLifecycle({
        operation: 'restore',
        outcome: 'failed',
        durationMs: elapsedMs(startedAt),
        failureCategory,
      });
      return undefined;
    }
  }

  private async publishWorkspaceBackup(options: {
    sandbox: SandboxInstance;
    bootstrapSession: Awaited<ReturnType<SandboxInstance['createSession']>>;
    workspacePath: string;
    candidate: WorkspaceBackupCandidate;
    bucket: R2Bucket;
    localBucket: boolean;
    onProgress?: EnsureWrapperRequest['onProgress'];
  }): Promise<void> {
    const { sandbox, bootstrapSession, workspacePath, candidate, bucket, localBucket, onProgress } =
      options;
    reportWorkspaceBackupProgress(onProgress, 'workspace_backup', 'Saving prepared workspace...');
    const startedAt = Date.now();
    logWorkspaceBackupLifecycle({ operation: 'create', outcome: 'started' });
    let failureCategory: WorkspaceBackupFailureCategory = 'source_commit_read_failed';
    try {
      const head = await bootstrapSession.exec(
        `git -C ${shellQuote(workspacePath)} rev-parse --verify HEAD`
      );
      const sourceCommit = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/i.test(sourceCommit)) {
        throw new Error('Cannot publish workspace backup without a readable HEAD');
      }
      failureCategory = 'active_origin_read_failed';
      const origin = await bootstrapSession.exec(
        `git -C ${shellQuote(workspacePath)} remote get-url origin`
      );
      if (origin.exitCode !== 0 || !origin.stdout.trim()) {
        throw new Error('Cannot capture active workspace origin');
      }
      const activeOrigin = origin.stdout.trim();
      let originChanged = false;
      let backup: Awaited<ReturnType<SandboxInstance['createBackup']>> | undefined;
      let publicationFailure:
        | { error: unknown; category: WorkspaceBackupFailureCategory }
        | undefined;
      let originRestored = true;
      try {
        failureCategory = 'canonical_origin_set_failed';
        const setCanonical = await bootstrapSession.exec(
          `git -C ${shellQuote(workspacePath)} remote set-url origin ${shellQuote(candidate.canonicalRepository)}`
        );
        if (setCanonical.exitCode !== 0)
          throw new Error('Failed to set canonical workspace origin');
        originChanged = true;
        failureCategory = 'backup_create_failed';
        backup = await sandbox.createBackup({
          dir: workspacePath,
          ttl: WORKSPACE_BACKUP_TTL_MS / 1000,
          multipart: false,
          ...(localBucket ? { localBucket: true } : {}),
        });
      } catch (error) {
        publicationFailure = { error, category: failureCategory };
      } finally {
        if (originChanged) {
          failureCategory = 'authenticated_origin_restore_failed';
          const restoreCommand = `git -C ${shellQuote(workspacePath)} remote set-url origin ${shellQuote(activeOrigin)}`;
          originRestored = false;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const restoreOrigin = await bootstrapSession.exec(restoreCommand);
            if (restoreOrigin.exitCode === 0) {
              originRestored = true;
              break;
            }
          }
        }
      }
      if (!originRestored) {
        throw new WorkspaceFilesystemPreparationError(
          'workspace_directory',
          'Failed to restore workspace repository authentication',
          new Error('Authenticated workspace origin restoration failed after two attempts')
        );
      }
      if (publicationFailure) {
        failureCategory = publicationFailure.category;
        throw publicationFailure.error;
      }
      failureCategory = 'backup_create_failed';
      if (!backup) throw new Error('Workspace backup creation returned no handle');
      failureCategory = 'backup_record_create_failed';
      const record = createWorkspaceBackupRecord(candidate, backup, sourceCommit);
      failureCategory = 'index_write_failed';
      await storeWorkspaceBackupRecord(bucket, candidate, record);
      logWorkspaceBackupLifecycle({
        operation: 'create',
        outcome: 'completed',
        durationMs: elapsedMs(startedAt),
      });
    } catch (error) {
      logWorkspaceBackupLifecycle({
        operation: 'create',
        outcome: 'failed',
        durationMs: elapsedMs(startedAt),
        failureCategory,
      });
      throw error;
    }
  }

  async ensureWrapper(request: EnsureWrapperRequest) {
    const { plan, prepared } = request;
    const { sessionId, userId, orgId } = plan.scope;
    this.sandboxIdPromise = Promise.resolve(plan.workspace.sandboxId as SandboxId);
    const sandboxId = await this.resolveSandboxId();
    const sandbox = await this.getSandbox({ sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });
    if (this.metadata.workspace?.managedScmContainment === true) {
      if (sandboxId.startsWith('dind-')) {
        throw ExecutionError.invalidRequest(
          'Managed SCM containment is not supported for DIND sandboxes'
        );
      }
      await sandbox.setOutboundHandler(MANAGED_SCM_OUTBOUND_HANDLER);
      logger.withFields({ sandboxId, sessionId }).info('Activated managed SCM containment');
    }

    if (this.requiresPreparedDevcontainerRuntime(request)) {
      let preparedWorkspace;
      try {
        preparedWorkspace = await withWorkspacePreparationTimeout(
          this.sessionService.prepareWorkspace({
            sandbox,
            sandboxId,
            orgId,
            userId,
            sessionId: sessionId as ServiceSessionId,
            kilocodeModel: plan.agent.model,
            env: this.env,
            metadata: plan.workspace.metadata,
            onProgress: request.onProgress,
          }),
          'devcontainer workspace preparation'
        );
      } catch (error) {
        if (error instanceof WorkspaceCapacityAdmissionRejectedError) throw error;
        const storageFull =
          error instanceof SandboxCapacityInspectionError ||
          isSandboxFilesystemUnusableError(error);
        throw ExecutionError.workspaceSetupFailed(
          storageFull ? 'Sandbox storage is full' : 'Devcontainer workspace preparation failed',
          error,
          {
            subtype: storageFull ? 'sandbox_storage_full' : 'workspace_setup_unknown',
            safeFailureMessage: storageFull
              ? 'Sandbox storage is full'
              : 'Devcontainer workspace preparation failed',
          }
        );
      }
      if (!preparedWorkspace.devcontainer || !preparedWorkspace.ready.devcontainer) {
        throw ExecutionError.workspaceSetupFailed(
          'Devcontainer workspace preparation did not resolve runtime metadata',
          undefined,
          {
            subtype: 'workspace_setup_unknown',
            safeFailureMessage:
              'Devcontainer workspace preparation did not resolve runtime metadata',
          }
        );
      }
      const toolCgroupEnv = buildToolCgroupEnv(this.env, orgId);
      let wrapper: Awaited<ReturnType<typeof WrapperClient.ensureWrapper>>;
      try {
        wrapper = await WrapperClient.ensureWrapper(sandbox, preparedWorkspace.session, {
          agentSessionId: sessionId,
          userId,
          workspacePath: preparedWorkspace.context.workspacePath,
          sessionId: plan.wrapper.kiloSessionId,
          runtimeEnv: preparedWorkspace.runtimeEnv,
          devcontainer: preparedWorkspace.devcontainer,
          fixedPort: preparedWorkspace.ready.devcontainer.wrapperPort,
          ...(request.leasedInstance ? { leasedInstance: request.leasedInstance } : {}),
          ...(toolCgroupEnv ? { toolCgroupEnv } : {}),
        });
      } catch (error) {
        throw ExecutionError.wrapperStartFailed(
          `Failed to start devcontainer wrapper: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
      await wrapper.client.updateRuntimeEnvironment(preparedWorkspace.runtimeEnv);
      return {
        status: 'session-ready' as const,
        client: wrapper.client,
        ready: preparedWorkspace.ready,
        kiloSessionId: wrapper.sessionId,
      };
    }

    const workspacePath = prepared.context.workspacePath;
    const workspaceWarm = await this.workspaceHasGit(sandbox, workspacePath);
    const backupMode = !workspaceWarm ? this.backupMode() : null;
    const backupCandidate = backupMode ? await this.buildBackupCandidate(request) : null;
    const restoredSourceCommit =
      backupCandidate && backupMode
        ? await this.restoreWorkspaceBackup(
            sandbox,
            workspacePath,
            backupCandidate,
            backupMode.bucket,
            request.onProgress
          )
        : undefined;
    const workspaceRestored = restoredSourceCommit !== undefined;
    let shouldPublishBackup = backupCandidate !== null && !workspaceRestored;
    if (!workspaceWarm && !workspaceRestored) {
      request.onProgress?.('disk_check', 'Checking disk space...');
      await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId, {
        inspectContainers: sandboxId.startsWith('dind-'),
      });
    }
    request.onProgress?.('kilo_server', 'Starting Kilo...');
    const bootstrapSession = await sandbox.createSession({
      name: `${sessionId}-bootstrap`,
      env: {},
      cwd: '/',
    });
    const bootstrapToolCgroupEnv = buildToolCgroupEnv(this.env, orgId);
    const wrapper = await WrapperClient.ensureBootstrapWrapper(sandbox, bootstrapSession, {
      agentSessionId: sessionId,
      userId,
      ...(request.leasedInstance ? { leasedInstance: request.leasedInstance } : {}),
      ...(bootstrapToolCgroupEnv ? { toolCgroupEnv: bootstrapToolCgroupEnv } : {}),
    });
    if (!prepared.readyRequest) {
      return { status: 'wrapper-running' as const, client: wrapper.client };
    }

    const readyRequest = workspaceRestored
      ? {
          ...prepared.readyRequest,
          workspace: {
            ...prepared.readyRequest.workspace,
            restoredFromBackup: true,
          },
        }
      : prepared.readyRequest;
    let readyResult: Awaited<ReturnType<WrapperClient['ensureSessionReady']>>;
    try {
      readyResult = await withWorkspacePreparationTimeout(
        wrapper.client.ensureSessionReady(readyRequest),
        'wrapper readiness'
      );
    } catch (error) {
      if (
        !workspaceRestored ||
        !(error instanceof WrapperError) ||
        error.code !== 'WORKSPACE_RECONCILIATION_FAILED'
      ) {
        throw error;
      }

      await this.cleanWorkspaceTarget(sandbox, workspacePath);
      request.onProgress?.('disk_check', 'Checking disk space...');
      await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId, {
        inspectContainers: sandboxId.startsWith('dind-'),
      });
      shouldPublishBackup = true;
      readyResult = await withWorkspacePreparationTimeout(
        wrapper.client.ensureSessionReady(prepared.readyRequest),
        'wrapper readiness after restored workspace fallback'
      );
    }
    if (shouldPublishBackup && backupCandidate && backupMode) {
      try {
        await this.publishWorkspaceBackup({
          sandbox,
          bootstrapSession,
          workspacePath,
          candidate: backupCandidate,
          bucket: backupMode.bucket,
          localBucket: backupMode.localBucket,
          onProgress: request.onProgress,
        });
      } catch (error) {
        if (error instanceof WorkspaceFilesystemPreparationError) throw error;
      }
    }
    return {
      status: 'session-ready' as const,
      client: wrapper.client,
      ready: readyResult.workspaceReady
        ? { ...prepared.ready, ...readyResult.workspaceReady }
        : prepared.ready,
      kiloSessionId: readyResult.kiloSessionId,
    };
  }

  async discoverSessionWrappers(): Promise<WrapperObservation> {
    return discoverSessionWrappers(await this.getSandbox(), this.metadata.identity.sessionId, {
      inspectContainers: this.usesDevcontainerRuntime(),
    });
  }

  private async observeTarget(_target: WrapperStopTarget): Promise<WrapperObservation> {
    // The lease is session-scoped: confirming absence must account for every
    // physical wrapper carrying this logical session marker, including duplicates.
    return this.discoverSessionWrappers();
  }

  async stopWrappers(request: {
    target: WrapperStopTarget;
    attemptId: string;
    reason: WrapperStopReason;
  }): Promise<StopWrappersResult> {
    const sandbox = await this.getSandbox();
    const initial = await this.observeTarget(request.target);
    if (initial.status !== 'present') return initial;

    try {
      await this.stopObserved(sandbox, this.metadata.identity.sessionId, initial.observed);
    } catch (error) {
      return { status: 'still-present', observed: initial.observed, error: String(error) };
    }

    let latest: WrapperObservation = initial;
    for (const delayMs of this.stopObservationDelaysMs) {
      await this.sleep(delayMs);
      latest = await this.observeTarget(request.target);
      if (latest.status !== 'present') return latest;
    }

    try {
      await this.stopObserved(sandbox, this.metadata.identity.sessionId, latest.observed, {
        force: true,
      });
    } catch (error) {
      return { status: 'still-present', observed: latest.observed, error: String(error) };
    }

    const final = await this.observeTarget(request.target);
    if (final.status === 'inspection-failed') return final;
    if (final.status === 'present') return { status: 'still-present', observed: final.observed };
    const stoppedInstanceIds = initial.observed.flatMap(observed =>
      observed.instanceId ? [observed.instanceId] : []
    );
    return stoppedInstanceIds.length > 0 ? { status: 'absent', stoppedInstanceIds } : final;
  }

  async probeHealth(): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.listProcesses();
  }

  async getRunningWrapper(): Promise<WrapperClient | null> {
    const sandbox = await this.getSandbox({ sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });
    const wrapper = await findWrapperForSession(sandbox, this.metadata.identity.sessionId);
    if (!wrapper) return null;
    const session = await sandbox.getSession(this.existingWrapperSessionName());
    return new WrapperClient({ session, port: wrapper.port });
  }

  async getRunningTerminalClient(): Promise<TerminalClientResult> {
    const sandbox = await this.getSandbox({ sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });
    const wrapper = await findWrapperForSession(sandbox, this.metadata.identity.sessionId);
    if (!wrapper) return { status: 'not-running' };
    const client = new WrapperContainerClient({ sandbox, port: wrapper.port });
    try {
      const health = await client.health();
      if (!health.healthy || health.version !== WRAPPER_VERSION) return { status: 'unhealthy' };
    } catch {
      return { status: 'unhealthy' };
    }
    return { status: 'ready', client };
  }

  async readWrapperLogs(): Promise<WrapperLogs | null> {
    const sandbox = await this.getSandbox({ sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });
    const session = await sandbox.getSession(this.existingWrapperSessionName());
    const logPaths: string[] = [];
    const wrapperFiles = await session.listFiles('/tmp').catch(() => undefined);
    if (wrapperFiles?.success) {
      for (const file of wrapperFiles.files) {
        if (
          file.type === 'file' &&
          file.name.startsWith('kilocode-wrapper-') &&
          file.name.endsWith('.log')
        ) {
          logPaths.push(file.absolutePath);
        }
      }
    }
    const sessionHome = getSessionHomePath(this.metadata.identity.sessionId);
    const cliFiles = await session
      .listFiles(`${sessionHome}/.local/share/kilo/log`, { recursive: true })
      .catch(() => undefined);
    if (cliFiles?.success) {
      for (const file of cliFiles.files) {
        if (file.type === 'file') logPaths.push(file.absolutePath);
      }
    }
    const files: Record<string, string> = {};
    const contents = await Promise.allSettled(
      logPaths.map(async path => ({
        path,
        content: (await session.readFile(path, { encoding: 'utf-8' })).content,
      }))
    );
    for (const content of contents) {
      if (content.status === 'fulfilled') files[content.value.path] = content.value.content;
    }
    let processes: WrapperLogs['processes'];
    try {
      processes = (await sandbox.listProcesses()).map(process => ({
        pid: Number.parseInt(process.id, 10) || 0,
        command: process.command,
        status: process.status,
      }));
    } catch {
      processes = undefined;
    }
    return { files, processes };
  }

  async keepAlive(): Promise<void> {
    const sandbox = await this.getSandbox();
    await Promise.resolve(sandbox.renewActivityTimeout());
  }

  async delete(reason: SandboxDeleteReason): Promise<void> {
    const sandbox = await this.getSandbox();
    if (reason === 'recovery') {
      await sandbox.destroy();
      return;
    }
    try {
      const session = await sandbox.getSession(this.metadata.identity.sessionId);
      await cleanupWorkspace(
        session,
        getSessionWorkspacePath(
          this.metadata.identity.orgId,
          this.metadata.identity.userId,
          this.metadata.identity.sessionId
        ),
        getSessionHomePath(this.metadata.identity.sessionId)
      );
    } catch {
      // Cleanup remains best effort before session resource deletion.
    }
    await sandbox.deleteSession(this.metadata.identity.sessionId);
  }
}
