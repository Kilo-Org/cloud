/**
 * New-plane (`workspace_*`) scenarios — plan B11.
 *
 * Every scenario declares `controlPlaneV2` (operator opt-in) AND
 * `controlPlaneRuntime` (a local-Docker proof that the owned container runs the
 * new-plane wrapper). The opt-in alone is not proof: the legacy plane also
 * issues `workspace_*` ids, so each scenario proves the runtime before it
 * asserts anything and cannot false-pass on the old plane.
 *
 * - `control-plane-callbacks`: registers the callback target through the internal
 *   `updateSession` endpoint (the public grouped `start` rejects callback
 *   targets), then requires one warm turn to produce a terminal callback and the
 *   persisted `cloud_agent_session_runs` report row.
 * - `command`: runs a `/compact` command turn and requires the live Kilo history
 *   summary count to increase — a real summarization, not just a completed turn.
 * - `attachment`: seeds an attachment and requires its content to reach the
 *   model request; the `attachments` seeding capability has no implementation
 *   yet, so this scenario is `unsupported` until one exists.
 * - `contained-credentials`: with containment advertised from the Worker
 *   `.dev.vars`, requires clone, model, and checkout read to complete and proves
 *   no raw SCM credential is in the container environment or git remote.
 */

import { randomUUID } from 'node:crypto';
import {
  failureReasonFromEvent,
  fakeDirective,
  fetchFakeLastPrompt,
  isMessageCompleted,
  openConnectedStream,
  sendCommand,
  sendMessage,
  updateSessionCallbackTarget,
  type StreamConnection,
  type StreamEvent,
  type WorktreeSessionResult,
} from './client.js';
import { cleanupRemoteSession, type SharedScenario } from './scenarios-shared.js';
import {
  awaitDurableTerminal,
  bootToCompletion,
  createOwnedSessionRegistry,
  createScenarioDeadline,
  sendTurn,
  trackCreations,
  waitForPresentAllocation,
  type ScenarioDeadline,
} from './scenarios-shared-runtime.js';
import { prepareSession } from './scenarios-shared-faults.js';
import { assertScenarioPreconditions } from './public-surface-support.js';
import { CONTROL_PLANE_WRAPPER_BASENAME } from './sandbox-control.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { CallbackSink, ScenarioEnvironment } from './scenario-capabilities.js';

const CONTROL_PLANE_TIMEOUT_MS = 15 * 60_000;
const BOOT_BUDGET_MS = 240_000;
const TURN_BUDGET_MS = 180_000;
const CALLBACK_BUDGET_MS = 60_000;
const REPORT_BUDGET_MS = 60_000;
const LATE_SETTLE_MS = 30_000;
/** Substrings that must never appear in a contained container's env or remote. */
const RAW_CREDENTIAL_MARKERS = [
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'github_pat_',
  'glpat-',
  'ATATT',
  'x-access-token:',
] as const;
/** Token-named env vars that must not exist at all in a contained container. */
const RAW_CREDENTIAL_ENV_NAMES =
  /^(GH_TOKEN|GITHUB_TOKEN|GIT_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|GITHUB_APP_INSTALLATION_TOKEN)$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCallbacks(env: ScenarioEnvironment): NonNullable<ScenarioEnvironment['callbacks']> {
  if (!env.callbacks) throw new Error('callbacks capability is required');
  return env.callbacks;
}

function requireReports(env: ScenarioEnvironment): NonNullable<ScenarioEnvironment['reports']> {
  if (!env.reports) throw new Error('reports capability is required');
  return env.reports;
}

function requireSandbox(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['sessionSandbox']> {
  if (!env.sessionSandbox) throw new Error('sessionSandbox capability is required');
  return env.sessionSandbox;
}

function requireControlPlaneRuntime(
  env: ScenarioEnvironment
): NonNullable<ScenarioEnvironment['controlPlaneRuntime']> {
  if (!env.controlPlaneRuntime) throw new Error('controlPlaneRuntime capability is required');
  return env.controlPlaneRuntime;
}

/**
 * The allocation reference used by `proveNewPlane` and the container
 * inspections, after waiting for the owned container to appear.
 */
async function controlPlaneAllocation(
  deadline: ScenarioDeadline,
  sandbox: NonNullable<ScenarioEnvironment['sessionSandbox']>,
  runtime: NonNullable<ScenarioEnvironment['controlPlaneRuntime']>,
  session: WorktreeSessionResult,
  label: string
): Promise<{ allocation: string; instanceId: string; pid: number }> {
  const allocation = await waitForPresentAllocation(
    deadline,
    sandbox,
    session,
    label,
    BOOT_BUDGET_MS
  );
  if (allocation === null) throw new Error(`${label} did not expose an allocation reference`);
  const proof = await runtime.proveNewPlane({
    cloudAgentSessionId: session.cloudAgentSessionId,
    kiloSessionId: session.kiloSessionId,
    expectedAllocationRef: allocation,
    wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
  });
  return { allocation, instanceId: proof.instanceId, pid: proof.pid };
}

type BootedControlPlane = {
  owned: ReturnType<typeof createOwnedSessionRegistry>;
  scenarioConfig: ReturnType<typeof createOwnedSessionRegistry>['config'];
  deadline: ScenarioDeadline;
  creations: ReturnType<typeof trackCreations<WorktreeSessionResult>>;
  session: WorktreeSessionResult;
  booted: Awaited<ReturnType<typeof bootToCompletion>>;
  allocation: string;
};

async function bootControlPlane(
  args: LifecycleArgs,
  env: ScenarioEnvironment,
  scenarioName: string,
  runId: string
): Promise<BootedControlPlane> {
  const { config } = args;
  const sandbox = requireSandbox(env);
  const runtime = requireControlPlaneRuntime(env);
  const startedAt = Date.now();
  const timeoutMs = args.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS;
  const owned = createOwnedSessionRegistry(config, cleanupRemoteSession);
  const scenarioConfig = owned.config;
  const deadline = createScenarioDeadline(startedAt, timeoutMs);
  const creations = trackCreations<WorktreeSessionResult>(deadline, owned, scenarioName);
  assertScenarioPreconditions(scenarioConfig, args.api);
  const session = await prepareSession(
    creations,
    scenarioConfig,
    fakeDirective(`echo:boot-${runId}`)
  );
  owned.register(session);
  const booted = await bootToCompletion(deadline, scenarioConfig, session, 'boot', text =>
    text.includes(`boot-${runId}`)
  );
  const { allocation } = await controlPlaneAllocation(deadline, sandbox, runtime, session, 'boot');
  return { owned, scenarioConfig, deadline, creations, session, booted, allocation };
}

function assertWorkspaceSession(sessionId: string, label: string): void {
  if (!/^workspace_[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new Error(`${label} did not receive a control-plane workspace_* identity: ${sessionId}`);
  }
}

async function closeCallbackSink(sink: CallbackSink | undefined): Promise<void> {
  try {
    await sink?.close();
  } catch {
    /* best-effort release */
  }
}

/**
 * Callback/report collection on the new plane. The report is the persisted
 * `cloud_agent_session_runs` row (what the queue consumer stored, so a dropped
 * schema-invalid report fails the scenario), and the callback is the grouped
 * execution callback. Both must exist for the same warm message.
 */
async function runControlPlaneCallbacks(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'control-plane-callbacks';
  const callbacks = requireCallbacks(env);
  const reports = requireReports(env);
  const runId = randomUUID();
  const events: StreamEvent[] = [];
  let sink: CallbackSink | undefined;
  let owned: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    sink = await callbacks.open();
    const boot = await bootControlPlane(args, env, scenarioName, runId);
    owned = boot;
    assertWorkspaceSession(boot.session.cloudAgentSessionId, scenarioName);
    events.push(...boot.booted.stream.events);

    // The public grouped `start` rejects `callbackTarget`; the new plane
    // registers it through the internal updateSession endpoint.
    const registered = await updateSessionCallbackTarget(
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      { url: sink.callbackUrl }
    );
    if (!registered.success) {
      throw new Error('updateSession did not accept the control-plane callback target');
    }

    const warm = await sendTurn(
      boot.deadline,
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      fakeDirective(`echo:cp-cb-${runId}`),
      'cp callback warm turn',
      TURN_BUDGET_MS
    );
    events.push(...warm.stream.events);
    warm.stream.close();

    const callback = await sink.waitFor(
      payload => payload.messageId === warm.messageId,
      Math.max(1, Math.min(CALLBACK_BUDGET_MS, boot.deadline.remaining('cp callback wait')))
    );
    if (callback === null) {
      throw new Error(`no callback arrived for control-plane message ${warm.messageId}`);
    }
    if (callback.status !== 'completed') {
      throw new Error(`control-plane callback status=${String(callback.status)} was not completed`);
    }

    const report = await reports.waitForReportRow({
      cloudAgentSessionId: boot.session.cloudAgentSessionId,
      messageId: warm.messageId,
      timeoutMs: Math.max(1, Math.min(REPORT_BUDGET_MS, boot.deadline.remaining('cp report wait'))),
    });
    if (report === null) {
      throw new Error(`no persisted report row for control-plane ${warm.messageId}`);
    }
    if (report.status !== 'completed') {
      throw new Error(`persisted report status=${report.status} was not completed`);
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; warmMessage=${warm.messageId}; ` +
        `callback=completed; report=${report.status}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (owned) {
      for (const late of await owned.creations.settleAll(LATE_SETTLE_MS)) {
        owned.owned.register(late);
      }
      await owned.owned.cleanup(scenarioName);
    }
    await closeCallbackSink(sink);
  }
  return result;
}

/**
 * `/compact` on the new plane. The command turn goes through `sendMessageV2`
 * (the unified `send` accepts prompts only), and the scenario requires the live
 * Kilo history summary count to increase: a completed turn alone does not prove
 * the session was summarised.
 */
async function runCommand(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'command';
  const runtime = requireControlPlaneRuntime(env);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    const active = await bootControlPlane(args, env, scenarioName, runId);
    boot = active;
    assertWorkspaceSession(active.session.cloudAgentSessionId, scenarioName);
    events.push(...active.booted.stream.events);
    const allocationRef = {
      cloudAgentSessionId: active.session.cloudAgentSessionId,
      kiloSessionId: active.session.kiloSessionId,
      expectedAllocationRef: active.allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    };
    const summariesBefore = await runtime.summaryCount(allocationRef);

    const commandStream = await active.deadline.within('command stream', signal =>
      openConnectedStream(
        active.scenarioConfig,
        active.session.cloudAgentSessionId,
        false,
        undefined,
        signal
      )
    );
    streams.push(commandStream);
    const command = await sendCommand(active.scenarioConfig, {
      cloudAgentSessionId: active.session.cloudAgentSessionId,
      command: 'compact',
    });
    const terminal = await commandStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, active.deadline.remaining('command terminal'))),
      command.messageId
    );
    if (!isMessageCompleted(terminal, command.messageId)) {
      throw new Error(
        `command ${command.messageId} failed: reason=${failureReasonFromEvent(terminal) ?? 'none'}`
      );
    }
    const status = await awaitDurableTerminal(
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      command.messageId,
      Math.max(1, Math.min(TURN_BUDGET_MS, boot.deadline.remaining('command durable')))
    );
    if (status !== 'completed') throw new Error(`command durable status=${status}`);

    const summariesAfter = await runtime.summaryCount(allocationRef);
    if (summariesAfter <= summariesBefore) {
      throw new Error(
        `compact completed but the Kilo summary count did not increase (${summariesBefore} -> ${summariesAfter})`
      );
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; command=${command.messageId}/completed; ` +
        `summaries=${summariesBefore}->${summariesAfter}`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/**
 * An attachment turn on the new plane. Requires the `attachments` seeding
 * capability (no profile provides R2 write access yet), so without it the whole
 * scenario is `unsupported`; it never sends an unreachable reference. With it,
 * the staged content must appear in the fake LLM's last user prompt, proving it
 * reached the model rather than only being read from disk.
 */
async function runAttachment(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'attachment';
  const runId = randomUUID().slice(0, 8);
  const content = `attachment-content-${runId}`;
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    if (!env.attachments) throw new Error('attachments capability is required');
    const active = await bootControlPlane(args, env, scenarioName, runId);
    boot = active;
    assertWorkspaceSession(active.session.cloudAgentSessionId, scenarioName);
    events.push(...active.booted.stream.events);

    const seeded = await env.attachments.seed({
      userId: active.scenarioConfig.user.id,
      name: `${runId}.txt`,
      contents: content,
    });
    const attachmentStream = await active.deadline.within('attachment stream', signal =>
      openConnectedStream(
        active.scenarioConfig,
        active.session.cloudAgentSessionId,
        false,
        undefined,
        signal
      )
    );
    streams.push(attachmentStream);
    const sent = await sendMessage(
      active.scenarioConfig,
      {
        cloudAgentSessionId: active.session.cloudAgentSessionId,
        prompt: fakeDirective(`echo:attach-${runId}`),
        attachments: seeded,
      },
      'unified'
    );
    const terminal = await attachmentStream.waitForTerminal(
      Math.max(1, Math.min(TURN_BUDGET_MS, active.deadline.remaining('attachment terminal'))),
      sent.messageId
    );
    if (!isMessageCompleted(terminal, sent.messageId)) {
      throw new Error(
        `attachment turn ${sent.messageId} failed: reason=${failureReasonFromEvent(terminal) ?? 'none'}`
      );
    }
    const lastPrompt = await fetchFakeLastPrompt(active.scenarioConfig.fakeLlmUrl);
    if (!lastPrompt.includes(content)) {
      throw new Error(
        `attachment content ${content} did not reach the model prompt (last prompt length ${lastPrompt.length})`
      );
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; attachment=${sent.messageId}/completed; ` +
        `contentReachedModel=true`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/**
 * Contained-credentials run (spec §11 scenario 7). Containment is read from the
 * Worker `.dev.vars`, so the scenario only runs when the Worker actually has it
 * enabled. A pass requires clone + model + checkout read to complete and proves
 * the negative: no raw SCM credential in the container environment or the git
 * remote. The harness cannot observe the credential lookup itself; a failure of
 * either check is the signal that containment did not apply.
 */
async function runContainedCredentials(
  args: LifecycleArgs,
  env: ScenarioEnvironment
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const { conversation } = args;
  const scenarioName = 'contained-credentials';
  const runtime = requireControlPlaneRuntime(env);
  const runId = randomUUID().slice(0, 8);
  const events: StreamEvent[] = [];
  const streams: StreamConnection[] = [];
  let boot: BootedControlPlane | undefined;
  let result: LifecycleResult;

  const fail = (message: string): LifecycleResult => ({
    name: scenarioName,
    conversation,
    ok: false,
    message,
    events: [...events],
    durationMs: Date.now() - startedAt,
  });

  try {
    boot = await bootControlPlane(args, env, scenarioName, runId);
    assertWorkspaceSession(boot.session.cloudAgentSessionId, scenarioName);
    events.push(...boot.booted.stream.events);

    const read = await sendTurn(
      boot.deadline,
      boot.scenarioConfig,
      boot.session.cloudAgentSessionId,
      fakeDirective(`file:read:contained-${runId}:README`),
      'contained checkout read',
      TURN_BUDGET_MS
    );
    streams.push(read.stream);
    events.push(...read.stream.events);
    read.stream.close();

    const allocationRef = {
      cloudAgentSessionId: boot.session.cloudAgentSessionId,
      kiloSessionId: boot.session.kiloSessionId,
      expectedAllocationRef: boot.allocation,
      wrapperProcessBasename: CONTROL_PLANE_WRAPPER_BASENAME,
    };
    const environment = await runtime.containerEnvironment(allocationRef);
    for (const [name, value] of Object.entries(environment)) {
      if (RAW_CREDENTIAL_ENV_NAMES.test(name)) {
        throw new Error(`contained container exposes a raw credential env var ${name}`);
      }
      const marker = RAW_CREDENTIAL_MARKERS.find(candidate => value.includes(candidate));
      if (marker !== undefined) {
        throw new Error(
          `contained container env ${name} still carries a raw credential (${marker})`
        );
      }
    }
    const remoteUrl = await runtime.gitRemoteUrl(allocationRef);
    if (remoteUrl !== null) {
      const marker = RAW_CREDENTIAL_MARKERS.find(candidate => remoteUrl.includes(candidate));
      if (marker !== undefined || /^[^/]*:[^@/]*@/.test(remoteUrl.replace(/^[a-z]+:\/\//i, ''))) {
        throw new Error('contained git remote still embeds a raw credential');
      }
    }

    result = {
      name: scenarioName,
      conversation,
      ok: true,
      message:
        `session=${boot.session.cloudAgentSessionId}; clone=completed; model=completed; ` +
        `checkoutRead=${read.messageId}=completed; envRawCredential=none; gitRemoteRawCredential=none`,
      events,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = fail(errorMessage(error));
  } finally {
    if (boot) {
      for (const late of await boot.creations.settleAll(LATE_SETTLE_MS)) {
        boot.owned.register(late);
      }
      await boot.owned.cleanup(scenarioName);
    }
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

export const CONTROL_PLANE_SHARED_SCENARIOS: Record<string, SharedScenario> = {
  'control-plane-callbacks': {
    name: 'control-plane-callbacks',
    requires: ['sessionSandbox', 'callbacks', 'reports', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runControlPlaneCallbacks,
  },
  command: {
    name: 'command',
    requires: ['sessionSandbox', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runCommand,
  },
  attachment: {
    name: 'attachment',
    requires: ['sessionSandbox', 'attachments', 'controlPlaneRuntime', 'controlPlaneV2'],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runAttachment,
  },
  'contained-credentials': {
    name: 'contained-credentials',
    requires: [
      'sessionSandbox',
      'controlPlaneRuntime',
      'controlPlaneV2',
      'credentialContainment',
    ],
    defaultApi: 'unified',
    defaultConversation: '_',
    defaultTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    run: runContainedCredentials,
  },
};
