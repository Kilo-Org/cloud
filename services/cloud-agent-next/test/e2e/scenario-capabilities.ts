/**
 * Scenario capability contracts and the shared-scenario gate.
 *
 * A shared scenario declares the capabilities it needs in `requires`. The
 * profile factory decides which capabilities a profile provides. This module is
 * the single owner of "can this scenario run here": it produces a pass-through,
 * an explicit `unsupported` result for a declared-but-absent capability, or a
 * loud error when the environment itself is missing. It contains no Docker or
 * database access; `LifecycleArgs`/`LifecycleResult` are imported type-only.
 */

import type { ApiVersion } from './client.js';
import type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import type { SandboxFaultReapEvidence } from './sandbox-fault-evidence.js';
import { cleanupRemoteSession } from './scenarios-shared.js';
import { createOwnedSessionRegistry } from './scenarios-shared-runtime.js';

export type Profile = 'local' | 'deployed' | 'local-http';

export type CapabilityName =
  | 'sandbox'
  | 'sessionSandbox'
  | 'deployedHttpAuthBoundary'
  | 'callbacks'
  | 'gates'
  | 'sandboxFaults'
  | 'controlPlaneV2'
  | 'controlPlaneRuntime'
  | 'credentialContainment'
  | 'attachments'
  | 'reports';

/**
 * Local container inspection. `waitForOwnedContainer` returns `null` on
 * timeout and throws when ownership is ambiguous; a throw is a failure, never
 * an unsupported result.
 */
export type SandboxObservation = {
  snapshotContainerIds(): Promise<ReadonlySet<string>>;
  waitForOwnedContainer(input: {
    cloudAgentSessionId: string;
    kiloSessionId: string;
    knownIds: ReadonlySet<string>;
    timeoutMs: number;
    /** Bounds this one wait; an aborted wait returns `null`. */
    signal?: AbortSignal;
  }): Promise<string | null>;
  waitForNewContainer(
    knownIds: ReadonlySet<string>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<string | null>;
};

export type DeployedAuthBoundaryObservation = { modelRoutesAuthenticated: true };

export type SessionSandboxWaitInput = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  timeoutMs: number;
  /** Bounds this one observation; an aborted wait returns `null`. */
  signal?: AbortSignal;
};

export type SessionSandboxCurrentInput = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  /** Bounds this one read. */
  signal?: AbortSignal;
};

/**
 * The session's physical container identity, as a stable string or `null`.
 *
 * This is a deliberately coarser substitution for the Docker-only
 * `waitForOwnedSandbox`/`listSandboxContainers` checks, and the two profiles
 * substitute differently:
 *
 * - local Docker passes an empty exclusion set, so it reports the session's
 *   container but does NOT prove it appeared after a pre-start snapshot;
 * - the HTTP profile reads the persisted control-plane `providerRef`, not a
 *   live runtime observation, so it proves an allocation exists and which
 *   provider reference it holds, not that the runtime is currently alive.
 *
 * Neither implementation can enumerate every container, so a "new container
 * appeared" check is only available where the Docker `sandbox` capability is
 * also present.
 */
export type SessionSandboxObservation = {
  waitForContainer(input: SessionSandboxWaitInput): Promise<string | null>;
  currentContainer(input: SessionSandboxCurrentInput): Promise<string | null>;
};

/**
 * A delivered callback body. The Worker sends the grouped execution callback
 * payload; only the fields the scenarios assert on are named here.
 */
export type CallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  messageId?: string;
  status?: string;
  lastAssistantMessageText?: string;
  [key: string]: unknown;
};

/**
 * One open callback target. `open()` starts a sink, `callbackUrl` is registered
 * on the session, and `close()` releases it. The local Docker profile backs this
 * with a host HTTP server; the HTTP profiles back it with the e2e surface sink.
 */
export type CallbackSink = {
  callbackUrl: string;
  records(signal?: AbortSignal): Promise<CallbackPayload[]>;
  waitFor(
    predicate: (payload: CallbackPayload) => boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CallbackPayload | null>;
  close(): Promise<void>;
};

export type CallbackObservation = { open(signal?: AbortSignal): Promise<CallbackSink> };

/**
 * A long parked `gate`/`hang` stream. The local Node fake keeps it open for the
 * scenario's lifetime; the deployed fake DO drops a parked stream on eviction,
 * so only the local profile provides this. A scenario that needs a genuinely
 * parked hold declares `gates` and is `unsupported` deployed.
 */
export type GatesObservation = { parkedStreamsSupported: true };

/**
 * The control-plane V2 (`workspace_*` new plane) is routed and launched. Plan
 * B11 writes scenarios against it before the C1 cutover, so the local profile
 * advertises this capability only when the operator opts in with
 * `E2E_CONTROL_PLANE_V2=1`. Without it every V2 scenario reports `unsupported`
 * with the missing-capability reason instead of failing against the legacy
 * plane.
 *
 * The flag alone is not proof: a `workspace_*` id prefix is produced by the
 * legacy plane too. Every V2 scenario additionally declares `controlPlaneRuntime`
 * and proves the owned container runs the new-plane wrapper before asserting
 * anything, so an opted-in run against a still-legacy plane fails loudly instead
 * of false-passing.
 */
export type ControlPlaneV2Observation = { ready: true };

/**
 * Local-Docker proof that the session's owned container runs the new plane.
 * `proveNewPlane` captures the new-plane control wrapper uniquely in the owned
 * container; a legacy container has no such process and the call throws. The
 * returned identity is the same physical handle the fault operations use.
 */
export type ControlPlaneRuntimeObservation = {
  proveNewPlane(allocation: SandboxFaultAllocation): Promise<{ instanceId: string; pid: number }>;
  /**
   * The text parts of one user message in the live Kilo history, via the Kilo
   * session-message API inside the owned container. Scenario 19 uses this to
   * require the replayed user turn appears once (the B8 duplicate-parts
   * behaviour would report two text parts).
   */
  userMessageParts(
    allocation: SandboxFaultAllocation,
    userMessageId: string
  ): Promise<{ found: boolean; textParts: number; text: string }>;
  /** Raw process environment of the owned container (containment negative check). */
  containerEnvironment(allocation: SandboxFaultAllocation): Promise<Record<string, string>>;
  /** The checkout's `origin` remote URL, or `null` (containment negative check). */
  gitRemoteUrl(allocation: SandboxFaultAllocation): Promise<string | null>;
  /** Count of summary (compaction) messages in the live Kilo history. */
  summaryCount(allocation: SandboxFaultAllocation): Promise<number>;
};

/**
 * The Worker under test resolves outbound clone/model credentials through the
 * contained lookup instead of direct credentials (spec §11 scenario 7). The
 * harness reads the Worker's own `.dev.vars` value (the same source the Worker
 * reads) so there is no second flag to keep in sync; a profile that cannot read
 * that source provides no capability and the scenario is `unsupported`.
 */
export type CredentialContainmentObservation = { enabled: true };

/**
 * One staged attachment reference that the Worker can download from R2
 * (`attachments.path` + `attachments.files`). Staging requires write access to
 * the attachments bucket, which no harness profile has today, so this is a
 * declared contract with no implementation yet: the command/attachment scenario
 * skips its attachment half with a reason rather than sending an unreachable
 * reference.
 */
export type SeededAttachment = { path: string; files: string[] };

export type AttachmentsObservation = {
  seed(input: { userId: string; name: string; contents: string }): Promise<SeededAttachment>;
};

/**
 * One persisted run-report row (`cloud_agent_session_runs`) for
 * `(cloudAgentSessionId, messageId)`. This is the report the queue consumer
 * wrote to Postgres, not the worker-log diagnostic: a report that the consumer
 * dropped (schema-invalid) leaves no row, so the scenario fails instead of
 * passing on an independent log line.
 */
export type ReportRow = {
  messageId: string;
  status: string;
  failureStage?: string;
  failureCode?: string;
  failureResponsibility?: string;
  failureReason?: string;
  terminalAt?: string;
};

/**
 * Local-only persisted-report observation, backed by the harness's
 * `DATABASE_URL`. A profile without a database connection provides no
 * capability, so a report-dependent scenario is `unsupported`.
 */
export type ReportsObservation = {
  /**
   * Poll for the persisted report row of `messageId` within `timeoutMs`.
   * Returns `null` when none is stored in the window.
   */
  waitForReportRow(input: {
    cloudAgentSessionId: string;
    messageId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<ReportRow | null>;
};

/**
 * The identity observed before a sandbox fault. The operation must fail closed
 * if the observed identity no longer matches, so a replacement cannot be
 * silently rediscovered and killed/frozen instead of the intended target.
 */
export type SandboxFaultTarget = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  expectedAllocationRef: string | null;
  /**
   * The wrapper identity captured from `captureWrapperIdentity` before the
   * fault. Every induction operation (kill, stop, freeze, unfreeze) verifies it
   * against the wrapper it observes or retains; a mismatch fails closed.
   *
   * Local profile contract: this is the `containerId:pid` **local
   * physical-process handle** captured from `/proc`, not durable
   * wrapper-instance identity. It guards against acting on a different local
   * process; it does not survive a container/wrapper replacement.
   */
  expectedWrapperInstanceId: string;
  /**
   * Which control-wrapper basename to capture and guard. Absent means the
   * legacy `kilocode-control-wrapper.js`; the new-plane scenarios set
   * `kilocode-control-plane-wrapper.js`, because a new-plane container has no
   * legacy wrapper process (and vice versa).
   */
  wrapperProcessBasename?: string;
};

/** The allocation half of a target, sufficient to capture a wrapper identity. */
export type SandboxFaultAllocation = Pick<
  SandboxFaultTarget,
  'cloudAgentSessionId' | 'kiloSessionId' | 'expectedAllocationRef' | 'wrapperProcessBasename'
>;

/**
 * Physical fault injection, provided only by the local Docker profile. There is
 * no public induction path, so the deployed profile provides no `sandboxFaults`
 * and every scenario that declares it is `unsupported` there.
 */
export type SandboxFaultObservation = {
  /**
   * Capture the observable identity of the owned container's wrapper process.
   * The scenario passes the returned `instanceId` back as
   * `expectedWrapperInstanceId`; if the identity cannot be established this
   * refuses (throws) rather than advertising guarded injection.
   */
  captureWrapperIdentity(
    allocation: SandboxFaultAllocation
  ): Promise<{ instanceId: string; pid: number }>;
  killOwnedContainer(
    target: SandboxFaultTarget
  ): Promise<{ killed: boolean; observedRef: string; detail: string }>;
  /**
   * `SIGUSR1` the captured control wrapper so it drops its socket and reconnects.
   * The new plane has no `session.attach` request diagnostic, so the boot
   * scenario signals as soon as the wrapper process exists instead of waiting
   * for a legacy attach record that never arrives.
   */
  recycleWrapperSocket(
    target: SandboxFaultTarget
  ): Promise<{ recycled: boolean; pid: number; detail: string }>;
  freezeWrapperProcess(
    target: SandboxFaultTarget
  ): Promise<{ frozen: boolean; pid: number; detail: string }>;
  unfreezeWrapperProcess(target: SandboxFaultTarget): Promise<void>;
  /**
   * `SIGKILL` the exact captured control-wrapper process (scenario 13). The
   * supervisor restarts the wrapper; the identity guards are the same as
   * `freezeWrapperProcess`.
   */
  killWrapperProcess(
    target: SandboxFaultTarget
  ): Promise<{ killed: boolean; pid: number; detail: string }>;
  /**
   * `SIGKILL` the captured `kilo serve` process for the session (scenario 12).
   * The Kilo root is discovered by `kiloSessionId` and the observed container
   * must match `expectedAllocationRef` and the wrapper identity must match
   * `expectedWrapperInstanceId`; a mismatch fails closed.
   */
  killKiloServerProcess(
    target: SandboxFaultTarget
  ): Promise<{ killed: boolean; pid: number; detail: string }>;
  /**
   * `SIGSTOP` the captured `kilo serve` process (scenario 19). The retained
   * handle backs `unfreezeKiloServerProcess`, so a stopped Kilo is never
   * rediscovered while it cannot answer.
   */
  freezeKiloServerProcess(
    target: SandboxFaultTarget
  ): Promise<{ frozen: boolean; pid: number; detail: string }>;
  unfreezeKiloServerProcess(target: SandboxFaultTarget): Promise<void>;
  /**
   * Capture the current `kilo serve` pid for the session, bound to the owned
   * container. Used to prove the pid changed after a Kilo restart, and that a
   * killed wrapper's old Kilo processes are gone.
   */
  captureKiloServerIdentity(allocation: SandboxFaultAllocation): Promise<{ pid: number }>;
  /** Whether a captured Kilo pid is still present in the owned container. */
  kiloServerProcessExists(allocation: SandboxFaultAllocation, pid: number): Promise<boolean>;
  /**
   * Cursor at the current end of the worker-log evidence stream. Capture it
   * before inducing a fault so a later `observeReapEvidence` only matches
   * records written after the fault.
   */
  captureEvidenceCursor(): Promise<number>;
  /**
   * Read the identity-correlated settled-reap evidence for the durable
   * `sandboxId` the caller read from `getSession`. The record is matched to that
   * id, never to the replacement; a missing cause stays `null`.
   */
  observeReapEvidence(input: {
    reapedAllocationRef: string;
    sandboxId: string;
    fromByte: number;
    waitMs: number;
    inflight: boolean;
    /** Stop waiting on a terminal `native_stop` instead of the legacy transition. */
    controlPlane?: boolean;
    messageId?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFaultReapEvidence>;
  /**
   * Byte offset at the current end of the local worker log, for a later bounded
   * read. The same cursor `captureEvidenceCursor` returns; the control-socket
   * scenarios correlate against it before signalling.
   */
  captureWorkerLogCursor(): Promise<number>;
  /**
   * Drop the owned container's control socket during the first attach and prove
   * from existing worker diagnostics that it closed and reconnected. It refuses
   * unless `containerId` still matches the observed owned container and its
   * control wrapper still matches `expectedWrapperInstanceId`, then signals
   * `SIGUSR1` to that captured process and requires, after a cursor captured
   * immediately before the signal, the ordered sequence `socket_closed` (this
   * attach connection, handshake complete) -> `handshake_committed` (a new
   * connection) -> `wrapper_ready` (that same new connection), all carrying the
   * same wrapper instance. An attach `socket_response` observed before that
   * close is a missed window and throws `attach window missed` (the only
   * retryable outcome); one observed after the close throws
   * `attach response after close`. Throws on any other deviation, including a
   * no-op signal.
   */
  dropControlSocketDuringAttach(input: {
    fromByte: number;
    sessionId: string;
    kiloSessionId: string;
    containerId: string;
    /**
     * Prior wrapper identity. When omitted, the process captured at signal time
     * is the identity: the new-plane scenario signals as soon as the container
     * exists, before a separate capture would lose the attach window.
     */
    expectedWrapperInstanceId?: string;
    /** Absent means the legacy wrapper basename. */
    wrapperProcessBasename?: string;
    waitForAttachMs: number;
  }): Promise<{
    attachRequestId: string;
    attachConnectionId: string;
    closedConnectionId: string;
    readyConnectionId: string;
    wrapperInstanceId: string;
    signaledPid: number;
  }>;
  /**
   * Count the `socket_request_sent` records for `session.prompt` on the session
   * written after `fromByte`. The caller asserts exactly one dispatch for the
   * turn.
   */
  countPromptDispatches(input: { fromByte: number; sessionId: string }): Promise<number>;
};

/**
 * Physical cleanup a profile owns once a scenario has released its sessions:
 * stop the sandboxes those sessions owned. It is not a scenario requirement, so
 * it is not a `CapabilityName`. Only a profile with a sandbox it may stop
 * (`local`) provides it. It reports problems and never throws.
 */
export type SandboxReclaim = (
  sessions: ReadonlyArray<{ sessionId: string; kiloSessionId?: string }>
) => Promise<void>;

export type ScenarioEnvironment = {
  profile: Profile;
  requireControlPlaneSession: boolean;
  reclaimSessions?: SandboxReclaim;
  sandbox?: SandboxObservation;
  sessionSandbox?: SessionSandboxObservation;
  deployedHttpAuthBoundary?: DeployedAuthBoundaryObservation;
  callbacks?: CallbackObservation;
  gates?: GatesObservation;
  sandboxFaults?: SandboxFaultObservation;
  controlPlaneV2?: ControlPlaneV2Observation;
  controlPlaneRuntime?: ControlPlaneRuntimeObservation;
  credentialContainment?: CredentialContainmentObservation;
  attachments?: AttachmentsObservation;
  reports?: ReportsObservation;
};

/** The shape `runSharedScenario` needs; `SharedScenario` is structurally assignable. */
export type RunnableSharedScenario = {
  name: string;
  requires: readonly CapabilityName[];
  /**
   * API surface the scenario must use. Absent means the caller selects the
   * surface (default `unified`); a pin (for example `legacy` for the callback
   * scenarios, because `callbackTarget` is accepted only by `prepareSession`)
   * is enforced by `resolveScenarioApi`.
   */
  defaultApi?: ApiVersion;
  run(args: LifecycleArgs, env: ScenarioEnvironment): Promise<LifecycleResult>;
};

export type ApiResolution = { ok: true; api: ApiVersion } | { ok: false; message: string };

/**
 * The single owner of the API decision, used by shared dispatch and by the
 * runners' reporting/admission. A definition that pins an API requires exactly
 * that API: a conflicting explicit selection fails clearly instead of silently
 * switching transport. An unpinned definition honours the caller's explicit
 * selection and defaults to `unified`.
 */
export function resolveScenarioApi(
  def: { name: string; defaultApi?: ApiVersion },
  requested: ApiVersion | undefined
): ApiResolution {
  const pinned = def.defaultApi;
  if (pinned === undefined) return { ok: true, api: requested ?? 'unified' };
  if (requested !== undefined && requested !== pinned) {
    return {
      ok: false,
      message:
        `scenario "${def.name}" requires the ${pinned} API; --api=${requested} conflicts with it. ` +
        `Rerun without --api or with --api=${pinned}.`,
    };
  }
  return { ok: true, api: pinned };
}

/**
 * Capabilities a profile must provide regardless of what a scenario declares.
 * `local` observes identity through Docker (`sandbox`) and `local-http` through
 * the e2e surface (`sessionSandbox`), so `local-http` must reject a definition
 * that declares no requirements. The Docker profile gates its missing capability
 * as an error; `local-http` gates it as `unsupported` so a caller without a
 * surface is never a scenario failure. Deployed-only scenarios (for example the
 * bad-signature probe) declare their own requirements, because not every
 * deployed scenario needs a session sandbox.
 */
export function mandatoryCapabilities(env: ScenarioEnvironment): CapabilityName[] {
  if (env.profile === 'local') return ['sandbox'];
  if (env.profile === 'local-http') return ['sessionSandbox'];
  return [];
}

/** Declared capabilities this environment does not provide. */
export function missingCapabilities(
  requires: readonly CapabilityName[],
  env: ScenarioEnvironment
): CapabilityName[] {
  return requires.filter(name => env[name] === undefined);
}

/** Every capability a definition needs here: profile-mandatory plus declared. */
function requiredCapabilities(
  requires: readonly CapabilityName[],
  env: ScenarioEnvironment
): CapabilityName[] {
  return [...new Set<CapabilityName>([...mandatoryCapabilities(env), ...requires])];
}

export type ScenarioSupportAssessment = {
  supported: boolean;
  /** Every capability this environment must provide (profile + declared). */
  required: CapabilityName[];
  /** The subset that is absent, in requirement order. */
  missing: CapabilityName[];
};

/**
 * The single support assessment, used by `runSharedScenario` dispatch and by the
 * matrix runners' expected-unsupported reporting. It is the missing-capability
 * check only: the local profile's missing mandatory `sandbox` is an error in
 * `runSharedScenario`, but the runners never dispatch a local scenario without a
 * `sandbox` capability in practice.
 */
export function assessScenarioSupport(
  definition: { requires: readonly CapabilityName[] },
  env: ScenarioEnvironment
): ScenarioSupportAssessment {
  const required = requiredCapabilities(definition.requires, env);
  const missing = missingCapabilities(required, env);
  return { supported: missing.length === 0, required, missing };
}

/** Boolean accessor over the single support assessment. */
export function isScenarioSupported(
  definition: { requires: readonly CapabilityName[] },
  env: ScenarioEnvironment
): boolean {
  return assessScenarioSupport(definition, env).supported;
}

/**
 * Resolve whether a shared scenario can run in `args.env`, before any side
 * effect. Gate order:
 *
 * 1. no injected environment → error (never a silent degraded run);
 * 2. the API selection: a definition pin that conflicts with an explicit
 *    `args.api` → error, so a pinned scenario never runs on the wrong
 *    transport. The resolved API is injected into the run to keep one owner;
 * 3. the Docker-backed `local` profile without the mandatory `sandbox`
 *    capability → error. `local-http` is exempt from this error and instead
 *    reports a missing mandatory `sessionSandbox` as `unsupported` (below),
 *    because it observes identity through the e2e surface;
 * 4. a declared or profile-mandatory capability that is absent → explicit
 *    `unsupported`;
 * 5. otherwise run the scenario. The gate owns teardown for every profile: the
 *    run receives a composed config that records every id a create reports, the
 *    ids are released after the run (interrupt then delete, newest first), and
 *    the profile's `reclaimSessions` then stops the sandboxes they owned, so a
 *    finished scenario does not hold memory until the idle stop.
 */
export async function runSharedScenario(
  def: RunnableSharedScenario,
  args: LifecycleArgs
): Promise<LifecycleResult> {
  const startedAt = Date.now();
  const env = args.env;
  const failed = (message: string): LifecycleResult => ({
    name: def.name,
    conversation: args.conversation,
    ok: false,
    message,
    events: [],
    durationMs: Date.now() - startedAt,
  });

  if (env === undefined) {
    return failed(`error: shared scenario "${def.name}" requires an injected ScenarioEnvironment`);
  }

  const resolvedApi = resolveScenarioApi(def, args.api);
  if (!resolvedApi.ok) {
    return failed(`error: ${resolvedApi.message}`);
  }

  if (env.profile === 'local' && env.sandbox === undefined) {
    return failed('error: local profile environment is missing the mandatory "sandbox" capability');
  }

  const support = assessScenarioSupport(def, env);
  if (!support.supported) {
    return {
      ...failed(
        `unsupported: shared scenario "${def.name}" requires unavailable capabilities: ${support.missing.join(', ')}`
      ),
      unsupported: true,
    };
  }

  const owned = createOwnedSessionRegistry(args.config, cleanupRemoteSession);
  try {
    return await def.run({ ...args, api: resolvedApi.api, config: owned.config }, env);
  } finally {
    await owned.cleanup(def.name);
    await env.reclaimSessions?.(owned.entries()).catch(error => {
      console.warn(
        `${def.name}: sandbox reclaim failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}
