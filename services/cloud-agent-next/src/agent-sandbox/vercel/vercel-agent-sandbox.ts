import { z } from 'zod';

import { WrapperClient } from '../../kilo/wrapper-client.js';
import { logger } from '../../logger.js';
import { WRAPPER_VERSION } from '../../shared/wrapper-version.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { SandboxBillingAdmissionResult } from '../../container-usage-context.js';
import {
  AgentSandboxUnavailableError,
  type AgentSandbox,
  type AgentSandboxRuntimeContext,
  type EnsureWrapperRequest,
  type StopWrappersResult,
  type TerminalClientResult,
  type WrapperInstanceLease,
  type WrapperLogs,
  type WrapperObservation,
  type WrapperStopReason,
  type WrapperStopTarget,
} from '../protocol.js';
import type { SandboxDeleteReason } from '../protocol.js';
import type { SandboxCreateIntent } from '../runtime-intents.js';
import type { VercelSandboxRuntimeConfig } from './vercel-runtime-config.js';
import { classifyVercelSession } from './vercel-runtime-state.js';
import {
  VercelSandboxRestClient,
  VercelSandboxRestError,
  type VercelSandboxCommand,
} from './vercel-sandbox-rest-client.js';
import { VercelWrapperTransport } from './vercel-wrapper-transport.js';

export const VERCEL_SANDBOX_UNAVAILABLE_MESSAGE =
  'Terminal access is unavailable for Vercel sandbox sessions';

const RUNTIME_MANIFEST_PATH = '/usr/local/share/kilo/runtime-manifest.json';
const WRAPPER_PATH = '/usr/local/bin/kilocode-wrapper.js';
const WRAPPER_PORT = 5000;
const MANIFEST_MAX_BYTES = 16 * 1024;
const WRAPPER_LOG_MAX_BYTES = 1024 * 1024;
const WRAPPER_HEALTH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 14_000];
const WRAPPER_LAUNCH_SETTLE_MS = 30_000;
const STOP_OBSERVATION_DELAYS_MS = [100, 500, 1_000];
const wrapperManifestSchema = z
  .object({
    runtimeBuildId: z.string().min(1),
    wrapperVersion: z.string().min(1),
    runtime: z.literal('node24'),
    bunVersion: z.string().min(1),
    wrapperSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

export type VercelAgentSandboxDependencies = {
  restClient?: VercelSandboxRestClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function observedWrapper(command: VercelSandboxCommand, instance?: WrapperInstanceLease) {
  return {
    representation: 'process' as const,
    id: command.id,
    ...(instance
      ? {
          instanceId: instance.instanceId,
          instanceGeneration: instance.instanceGeneration,
        }
      : {}),
  };
}

export class VercelAgentSandbox implements AgentSandbox {
  private readonly restClient: VercelSandboxRestClient;
  private readonly injectedRestClient?: VercelSandboxRestClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private runtimeSessionId?: string;
  private wrapperProcess?: NonNullable<
    NonNullable<SessionMetadata['workspace']>['providerRuntime']
  >['wrapper'];

  constructor(
    private readonly metadata: SessionMetadata,
    private readonly config: VercelSandboxRuntimeConfig,
    private readonly runtimeContext?: AgentSandboxRuntimeContext,
    dependencies: VercelAgentSandboxDependencies = {}
  ) {
    this.injectedRestClient = dependencies.restClient;
    this.restClient =
      this.injectedRestClient ??
      new VercelSandboxRestClient({
        accessToken: config.accessToken,
        teamId: config.teamId,
        projectId: config.projectId,
        fetch,
      });
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = dependencies.now ?? Date.now;
    this.runtimeSessionId = metadata.workspace?.providerRuntime?.sessionId;
    this.wrapperProcess = metadata.workspace?.providerRuntime?.wrapper;
  }

  async ensureBillingAdmission(): Promise<SandboxBillingAdmissionResult> {
    return {
      success: false,
      code: 'meter_unavailable',
      message: 'Container billing admission is unavailable for Vercel sandbox sessions',
    };
  }

  async isBillingBlocked(enforcementRequested = false): Promise<boolean> {
    return enforcementRequested;
  }

  async getBillingRuntimeStatus(): Promise<undefined> {
    return undefined;
  }

  private get sandboxName(): string {
    const sandboxName = this.metadata.workspace?.sandboxId;
    if (!sandboxName) throw new AgentSandboxUnavailableError('Vercel sandbox name is unavailable');
    return sandboxName;
  }

  private get persistedRuntime() {
    return this.runtimeSessionId
      ? {
          provider: 'vercel' as const,
          sessionId: this.runtimeSessionId,
          wrapper: this.wrapperProcess,
        }
      : undefined;
  }

  private requireRuntimeContext(): AgentSandboxRuntimeContext {
    if (!this.runtimeContext) {
      throw new AgentSandboxUnavailableError(
        'Vercel sandbox mutation requires the owning session runtime context'
      );
    }
    return this.runtimeContext;
  }

  private createRestClient(projectId: string): VercelSandboxRestClient {
    return (
      this.injectedRestClient ??
      new VercelSandboxRestClient({
        accessToken: this.config.accessToken,
        teamId: this.config.teamId,
        projectId,
        fetch,
      })
    );
  }

  private createInput(intent: SandboxCreateIntent) {
    return {
      name: intent.sandboxName,
      operationId: intent.operationId,
      runtimeBuildId: intent.runtimeBuildId,
      snapshotId: intent.snapshotId,
      runtime: intent.runtime,
      timeoutMs: this.config.initialTimeoutMs,
    };
  }

  private async ensureRuntimeSession(): Promise<string> {
    const context = this.requireRuntimeContext();
    if (await context.isDeletionPending()) {
      throw new AgentSandboxUnavailableError(
        'Vercel sandbox deletion is pending',
        'runtime_not_running'
      );
    }
    if (this.persistedRuntime?.sessionId) return this.persistedRuntime.sessionId;
    const existingIntent = await context.getCreateIntent();
    const intent =
      existingIntent ??
      (await context.beginCreate({
        provider: 'vercel',
        sandboxName: this.sandboxName,
        projectId: this.config.projectId,
        snapshotId: this.config.snapshotId,
        runtimeBuildId: this.config.runtimeBuildId,
        runtime: this.config.runtime,
      }));
    const createClient = this.createRestClient(intent.projectId);

    let runtime;
    if (existingIntent) {
      runtime = await createClient.inspectByName(this.createInput(intent));
      if (!runtime) {
        if (this.now() < intent.settleUntil) {
          throw new AgentSandboxUnavailableError(
            'Vercel sandbox creation is still settling',
            'runtime_creation_failed'
          );
        }
        await context.clearCreateIntent(intent.operationId);
        throw new AgentSandboxUnavailableError(
          'Vercel sandbox creation was conclusively absent',
          'runtime_creation_failed'
        );
      }
    } else {
      runtime = await createClient.createSandbox(this.createInput(intent));
    }
    if (await context.isDeletionPending()) {
      throw new AgentSandboxUnavailableError(
        'Vercel sandbox deletion won creation',
        'runtime_not_running'
      );
    }
    await context.persistRuntimeOnce({
      provider: 'vercel',
      sessionId: runtime.session.id,
      projectId: intent.projectId,
      snapshotId: intent.snapshotId,
      runtimeBuildId: intent.runtimeBuildId,
      runtime: intent.runtime,
    });
    this.runtimeSessionId = runtime.session.id;
    return runtime.session.id;
  }

  private async validateRuntimeManifest(sessionId: string): Promise<void> {
    const bytes = await this.restClient.readFile(
      sessionId,
      RUNTIME_MANIFEST_PATH,
      MANIFEST_MAX_BYTES
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AgentSandboxUnavailableError(
        'Vercel runtime manifest is invalid',
        'runtime_configuration_drift'
      );
    }
    const parsed = wrapperManifestSchema.safeParse(manifest);
    if (
      !parsed.success ||
      parsed.data.runtimeBuildId !== this.config.runtimeBuildId ||
      parsed.data.wrapperVersion !== WRAPPER_VERSION ||
      parsed.data.runtime !== this.config.runtime
    ) {
      throw new AgentSandboxUnavailableError(
        'Vercel runtime manifest does not match the pinned runtime',
        'runtime_configuration_drift'
      );
    }

    const verificationPath = `/tmp/kilo-runtime-verification-${crypto.randomUUID()}.txt`;
    try {
      await this.restClient.executeCommand(sessionId, {
        command: 'sh',
        args: [
          '-lc',
          `bun --version > ${verificationPath} && sha256sum ${WRAPPER_PATH} | cut -d' ' -f1 >> ${verificationPath}`,
        ],
        cwd: '/',
        env: {},
        sudo: false,
        wait: true,
      });
      const verification = new TextDecoder()
        .decode(await this.restClient.readFile(sessionId, verificationPath, 256))
        .trim()
        .split('\n');
      if (
        verification.length !== 2 ||
        verification[0] !== parsed.data.bunVersion ||
        verification[1] !== parsed.data.wrapperSha256
      ) {
        throw new AgentSandboxUnavailableError(
          'Vercel runtime artifacts do not match the runtime manifest',
          'runtime_configuration_drift'
        );
      }
    } finally {
      await this.restClient
        .executeCommand(sessionId, {
          command: 'rm',
          args: ['-f', '--', verificationPath],
          cwd: '/',
          env: {},
          sudo: false,
          wait: true,
        })
        .catch(() => undefined);
    }
  }

  private wrapperClient(sessionId: string): WrapperClient {
    return new WrapperClient({
      transport: new VercelWrapperTransport({
        restClient: this.restClient,
        sessionId,
        port: WRAPPER_PORT,
      }),
    });
  }

  private commandMatchesLaunch(command: VercelSandboxCommand, launchId: string): boolean {
    return command.args.some(argument => argument.includes(`kilo-launch:${launchId}`));
  }

  private async recoverLaunchCommand(sessionId: string, launchId: string) {
    const matches = (await this.restClient.listCommands(sessionId)).filter(
      command => command.exitCode === null && this.commandMatchesLaunch(command, launchId)
    );
    if (matches.length !== 1) {
      throw new AgentSandboxUnavailableError(
        matches.length === 0
          ? 'Vercel wrapper launch is still unresolved'
          : 'Vercel wrapper launch matched multiple commands',
        'runtime_infrastructure_failed'
      );
    }
    return matches[0];
  }

  private async ensureWrapperCommand(
    sessionId: string,
    instance: WrapperInstanceLease
  ): Promise<VercelSandboxCommand> {
    const context = this.requireRuntimeContext();
    if (await context.isDeletionPending()) {
      throw new AgentSandboxUnavailableError(
        'Vercel sandbox deletion is pending',
        'runtime_not_running'
      );
    }
    const persisted = this.persistedRuntime?.wrapper;
    if (persisted) {
      const command = await this.observeCommand(sessionId, persisted.commandId);
      if (command) {
        if (
          persisted.instanceId !== instance.instanceId ||
          persisted.instanceGeneration !== instance.instanceGeneration
        ) {
          throw new AgentSandboxUnavailableError(
            'Persisted Vercel wrapper belongs to a different physical lease',
            'runtime_infrastructure_failed'
          );
        }
        return command;
      }
      await context.clearWrapperProcess({ sessionId, commandId: persisted.commandId });
      this.wrapperProcess = undefined;
    }
    const existingIntent = await context.getWrapperLaunchIntent();
    const intent = existingIntent ?? (await context.beginWrapperLaunch({ sessionId, instance }));
    if (
      intent.sessionId !== sessionId ||
      intent.instanceId !== instance.instanceId ||
      intent.instanceGeneration !== instance.instanceGeneration
    ) {
      throw new AgentSandboxUnavailableError(
        'Vercel wrapper launch intent does not match the current lease',
        'runtime_infrastructure_failed'
      );
    }

    const command = existingIntent
      ? await this.recoverLaunchCommand(sessionId, intent.launchId)
      : await this.restClient.executeCommand(sessionId, {
          command: 'sh',
          args: [
            '-lc',
            `exec bun run ${WRAPPER_PATH} --agent-session "$KILO_AGENT_SESSION_ID" --user-id "$KILO_USER_ID" # kilo-launch:${intent.launchId}`,
          ],
          cwd: '/',
          env: {
            WRAPPER_PORT: String(WRAPPER_PORT),
            WRAPPER_LOG_PATH: `/tmp/kilocode-wrapper-${this.metadata.identity.sessionId}.log`,
            KILO_AGENT_SESSION_ID: this.metadata.identity.sessionId,
            KILO_USER_ID: this.metadata.identity.userId,
            KILO_CLOUD_AGENT: '1',
            KILO_SESSION_RETRY_LIMIT: '5',
            WRAPPER_INSTANCE_ID: intent.instanceId,
            WRAPPER_INSTANCE_GENERATION: String(intent.instanceGeneration),
          },
          sudo: false,
          wait: false,
        });
    await context.persistWrapperProcessOnce({
      sessionId,
      launchId: intent.launchId,
      commandId: command.id,
      instance,
    });
    this.wrapperProcess = {
      launchId: intent.launchId,
      commandId: command.id,
      instanceId: instance.instanceId,
      instanceGeneration: instance.instanceGeneration,
    };
    return command;
  }

  private async waitForHealthyWrapper(
    client: WrapperClient,
    instance: WrapperInstanceLease
  ): Promise<void> {
    for (let attempt = 0; attempt <= WRAPPER_HEALTH_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const health = await client.health();
        if (
          health.healthy &&
          health.version === WRAPPER_VERSION &&
          health.wrapperInstanceId === instance.instanceId &&
          health.wrapperInstanceGeneration === instance.instanceGeneration
        ) {
          return;
        }
      } catch {
        // Wrapper startup remains observable through the next bounded health attempt.
      }
      const delay = WRAPPER_HEALTH_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) await this.sleep(delay);
    }
    throw new Error('Vercel wrapper did not report the persisted lease');
  }

  async ensureWrapper(request: EnsureWrapperRequest) {
    const instance = request.leasedInstance;
    if (!instance) throw new Error('Vercel wrapper startup requires a physical wrapper lease');
    const sessionId = await this.ensureRuntimeSession();
    await this.validateRuntimeManifest(sessionId);
    await this.ensureWrapperCommand(sessionId, instance);
    const client = this.wrapperClient(sessionId);
    await this.waitForHealthyWrapper(client, instance);
    return { status: 'wrapper-running' as const, client };
  }

  async observeWrappersWithoutWaking(): Promise<WrapperObservation> {
    const runtime = this.persistedRuntime;
    if (!runtime?.wrapper) return { status: 'absent' };

    try {
      const session = await this.restClient.getSession(runtime.sessionId, this.sandboxName);
      if (classifyVercelSession(session.session.status) === 'terminal') {
        return { status: 'absent' };
      }
      if (session.session.status !== 'running') {
        return {
          status: 'inspection-failed',
          error: `Vercel sandbox runtime is ${session.session.status}`,
        };
      }

      const command = await this.observeCommand(runtime.sessionId, runtime.wrapper.commandId);
      if (!command) return { status: 'absent' };
      return {
        status: 'present',
        observed: [
          observedWrapper(command, {
            instanceId: runtime.wrapper.instanceId,
            instanceGeneration: runtime.wrapper.instanceGeneration,
          }),
        ],
      };
    } catch (error) {
      if (error instanceof VercelSandboxRestError && error.status === 404) {
        return { status: 'absent' };
      }
      return { status: 'inspection-failed', error: String(error) };
    }
  }

  async discoverSessionWrappers(): Promise<WrapperObservation> {
    const runtime = this.persistedRuntime;
    if (!runtime) return { status: 'absent' };
    try {
      if (!runtime.wrapper) {
        const intent = await this.runtimeContext?.getWrapperLaunchIntent();
        if (!intent) return { status: 'absent' };
        if (intent.sessionId !== runtime.sessionId) {
          throw new Error('Vercel wrapper launch intent targets a different session');
        }
        const matches = (await this.restClient.listCommands(runtime.sessionId)).filter(
          command =>
            command.exitCode === null && this.commandMatchesLaunch(command, intent.launchId)
        );
        if (matches.length > 1) {
          throw new Error('Vercel wrapper launch matched multiple commands during discovery');
        }
        const command = matches[0];
        if (command) {
          return {
            status: 'present',
            observed: [
              observedWrapper(command, {
                instanceId: intent.instanceId,
                instanceGeneration: intent.instanceGeneration,
              }),
            ],
          };
        }
        if (this.now() - intent.startedAt < WRAPPER_LAUNCH_SETTLE_MS) {
          throw new Error('Vercel wrapper launch is still settling during discovery');
        }
        await this.runtimeContext?.clearWrapperLaunchIntent(intent.launchId);
        return { status: 'absent' };
      }
      const command = await this.observeCommand(runtime.sessionId, runtime.wrapper.commandId);
      if (!command) {
        await this.runtimeContext?.clearWrapperProcess({
          sessionId: runtime.sessionId,
          commandId: runtime.wrapper.commandId,
        });
        this.wrapperProcess = undefined;
        return { status: 'absent' };
      }
      return {
        status: 'present',
        observed: [
          observedWrapper(command, {
            instanceId: runtime.wrapper.instanceId,
            instanceGeneration: runtime.wrapper.instanceGeneration,
          }),
        ],
      };
    } catch (error) {
      return { status: 'inspection-failed', error: String(error) };
    }
  }

  private async observeCommand(
    sessionId: string,
    commandId: string
  ): Promise<VercelSandboxCommand | null> {
    try {
      const command = await this.restClient.getCommand(sessionId, commandId);
      return command.exitCode === null ? command : null;
    } catch (error) {
      if (error instanceof VercelSandboxRestError && error.status === 404) return null;
      throw error;
    }
  }

  private async reconcileWrapperForStop(target: WrapperStopTarget): Promise<void> {
    const runtime = this.persistedRuntime;
    if (!runtime || runtime.wrapper || !this.runtimeContext) return;
    const intent = await this.runtimeContext.getWrapperLaunchIntent();
    if (!intent) return;
    if (
      target.kind === 'instance' &&
      (intent.instanceId !== target.instance.instanceId ||
        intent.instanceGeneration !== target.instance.instanceGeneration)
    ) {
      return;
    }
    if (intent.sessionId !== runtime.sessionId) {
      throw new Error('Vercel wrapper launch intent targets a different session');
    }
    const matches = (await this.restClient.listCommands(runtime.sessionId)).filter(
      command => command.exitCode === null && this.commandMatchesLaunch(command, intent.launchId)
    );
    if (matches.length > 1) {
      throw new Error('Vercel wrapper launch matched multiple commands during cleanup');
    }
    const command = matches[0];
    if (!command) {
      if (this.now() - intent.startedAt < WRAPPER_LAUNCH_SETTLE_MS) {
        throw new Error('Vercel wrapper launch is still settling during cleanup');
      }
      await this.runtimeContext.clearWrapperLaunchIntent(intent.launchId);
      return;
    }
    await this.runtimeContext.persistWrapperProcessOnce({
      sessionId: runtime.sessionId,
      launchId: intent.launchId,
      commandId: command.id,
      instance: {
        instanceId: intent.instanceId,
        instanceGeneration: intent.instanceGeneration,
      },
    });
    this.wrapperProcess = {
      launchId: intent.launchId,
      commandId: command.id,
      instanceId: intent.instanceId,
      instanceGeneration: intent.instanceGeneration,
    };
  }

  async stopWrappers(request: {
    target: WrapperStopTarget;
    attemptId: string;
    reason: WrapperStopReason;
  }): Promise<StopWrappersResult> {
    try {
      await this.reconcileWrapperForStop(request.target);
    } catch (error) {
      return { status: 'inspection-failed', error: String(error) };
    }
    const runtime = this.persistedRuntime;
    if (!runtime?.wrapper) return { status: 'absent' };
    if (
      request.target.kind === 'instance' &&
      (runtime.wrapper.instanceId !== request.target.instance.instanceId ||
        runtime.wrapper.instanceGeneration !== request.target.instance.instanceGeneration)
    ) {
      return { status: 'absent' };
    }
    const { commandId } = runtime.wrapper;
    const initial = await this.observeCommand(runtime.sessionId, commandId);
    if (!initial) {
      await this.runtimeContext?.clearWrapperProcess({ sessionId: runtime.sessionId, commandId });
      this.wrapperProcess = undefined;
      return { status: 'absent', stoppedInstanceIds: [runtime.wrapper.instanceId] };
    }
    await this.restClient.killCommand(runtime.sessionId, commandId, 15);
    for (const delay of STOP_OBSERVATION_DELAYS_MS) {
      await this.sleep(delay);
      if (!(await this.observeCommand(runtime.sessionId, commandId))) {
        await this.runtimeContext?.clearWrapperProcess({ sessionId: runtime.sessionId, commandId });
        this.wrapperProcess = undefined;
        return { status: 'absent', stoppedInstanceIds: [runtime.wrapper.instanceId] };
      }
    }
    await this.restClient.killCommand(runtime.sessionId, commandId, 9);
    const final = await this.observeCommand(runtime.sessionId, commandId);
    if (final) {
      return {
        status: 'still-present',
        observed: [
          observedWrapper(final, {
            instanceId: runtime.wrapper.instanceId,
            instanceGeneration: runtime.wrapper.instanceGeneration,
          }),
        ],
      };
    }
    await this.runtimeContext?.clearWrapperProcess({ sessionId: runtime.sessionId, commandId });
    this.wrapperProcess = undefined;
    return { status: 'absent', stoppedInstanceIds: [runtime.wrapper.instanceId] };
  }

  async probeHealth(): Promise<void> {
    const runtime = this.persistedRuntime;
    if (!runtime)
      throw new AgentSandboxUnavailableError(
        'Vercel runtime is not running',
        'runtime_not_running'
      );
    const session = await this.restClient.getSession(runtime.sessionId, this.sandboxName);
    if (session.session.status !== 'running') {
      throw new AgentSandboxUnavailableError(
        'Vercel runtime is not running',
        'runtime_not_running'
      );
    }
  }

  async getRunningWrapper(): Promise<WrapperClient | null> {
    const runtime = this.persistedRuntime;
    if (!runtime?.wrapper) return null;
    const command = await this.observeCommand(runtime.sessionId, runtime.wrapper.commandId);
    return command ? this.wrapperClient(runtime.sessionId) : null;
  }

  async getRunningTerminalClient(): Promise<TerminalClientResult> {
    return {
      status: 'capability-unavailable',
      message: VERCEL_SANDBOX_UNAVAILABLE_MESSAGE,
    };
  }

  async readWrapperLogs(): Promise<WrapperLogs | null> {
    const runtime = this.persistedRuntime;
    if (!runtime?.wrapper) return null;
    const path = `/tmp/kilocode-wrapper-${this.metadata.identity.sessionId}.log`;
    try {
      const content = await this.restClient.readFile(
        runtime.sessionId,
        path,
        WRAPPER_LOG_MAX_BYTES
      );
      return { files: { [path]: new TextDecoder().decode(content) } };
    } catch {
      return { files: {} };
    }
  }

  async keepAlive(): Promise<void> {
    const runtime = this.persistedRuntime;
    if (!runtime) return;
    const inspected = await this.restClient.getSession(runtime.sessionId, this.sandboxName);
    if (inspected.session.status !== 'running') return;
    const startedAt = inspected.session.startedAt ?? inspected.session.requestedAt;
    const expiresAt = startedAt + inspected.session.timeout;
    const extensionWatermarkMs = Math.max(60_000, Math.floor(this.config.extendDurationMs / 2));
    if (expiresAt - this.now() > extensionWatermarkMs) return;
    await this.restClient.extendSessionTimeout(
      runtime.sessionId,
      this.sandboxName,
      this.config.extendDurationMs
    );
  }

  async delete(reason: SandboxDeleteReason): Promise<void> {
    // VM teardown is reconciled by the session deletion tombstone
    // (VercelSandboxLifecycle); the adapter has nothing to tear down here.
    logger
      .withFields({ sessionId: this.metadata.identity.sessionId, reason })
      .debug('Vercel sandbox delete deferred to the session deletion tombstone');
  }
}
