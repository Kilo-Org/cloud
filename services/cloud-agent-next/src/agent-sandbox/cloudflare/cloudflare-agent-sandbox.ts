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
import { SANDBOX_SLEEP_AFTER_SECONDS } from '../../core/lease.js';
import { generateSandboxId, getSandboxNamespace } from '../../sandbox-id.js';
import { SessionService } from '../../session-service.js';
import { WrapperClient, WrapperContainerClient } from '../../kilo/wrapper-client.js';
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
import {
  isSandboxFilesystemUnusableError,
  SandboxCapacityInspectionError,
} from '../../workspace-errors.js';

const PREPARE_WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STOP_OBSERVATION_DELAYS_MS = [100, 500, 1_000];

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
          ? getSandbox(getSandboxNamespace(this.env, sandboxId), sandboxId, options)
          : getSandbox(getSandboxNamespace(this.env, sandboxId), sandboxId));
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
            this.metadata.identity.botId
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

  async ensureWrapper(request: EnsureWrapperRequest) {
    const { plan, prepared } = request;
    const { sessionId, userId, orgId } = plan.scope;
    this.sandboxIdPromise = Promise.resolve(plan.workspace.sandboxId as SandboxId);
    const sandboxId = await this.resolveSandboxId();
    const sandbox = await this.getSandbox({ sleepAfter: SANDBOX_SLEEP_AFTER_SECONDS });

    if (this.requiresPreparedDevcontainerRuntime(request)) {
      const preparedWorkspace = await withWorkspacePreparationTimeout(
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
      if (!preparedWorkspace.devcontainer || !preparedWorkspace.ready.devcontainer) {
        throw ExecutionError.workspaceSetupFailed(
          'Devcontainer workspace preparation did not resolve runtime metadata'
        );
      }
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
        });
      } catch (error) {
        throw ExecutionError.wrapperStartFailed(
          `Failed to start devcontainer wrapper: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
      return {
        status: 'session-ready' as const,
        client: wrapper.client,
        ready: preparedWorkspace.ready,
        kiloSessionId: wrapper.sessionId,
      };
    }

    const workspaceWarm = await this.workspaceHasGit(sandbox, prepared.context.workspacePath);
    if (!workspaceWarm) {
      request.onProgress?.('disk_check', 'Checking disk space...');
      await checkDiskAndCleanBeforeSetup(sandbox, orgId, userId, sessionId);
    }
    request.onProgress?.('kilo_server', 'Starting Kilo...');
    const bootstrapSession = await sandbox.createSession({
      name: `${sessionId}-bootstrap`,
      env: {},
      cwd: '/',
    });
    const wrapper = await WrapperClient.ensureBootstrapWrapper(sandbox, bootstrapSession, {
      agentSessionId: sessionId,
      userId,
      ...(request.leasedInstance ? { leasedInstance: request.leasedInstance } : {}),
    });
    return { status: 'wrapper-running' as const, client: wrapper.client };
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
