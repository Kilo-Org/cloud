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

export type Profile = 'local' | 'deployed' | 'local-http';

export type CapabilityName =
  | 'sandbox'
  | 'sessionSandbox'
  | 'deployedHttpAuthBoundary'
  | 'callbacks';

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
  }): Promise<string | null>;
  waitForNewContainer(knownIds: ReadonlySet<string>, timeoutMs: number): Promise<string | null>;
};

export type DeployedAuthBoundaryObservation = { modelRoutesAuthenticated: true };

export type SessionSandboxWaitInput = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  timeoutMs: number;
};

export type SessionSandboxCurrentInput = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
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
  records(): Promise<CallbackPayload[]>;
  waitFor(
    predicate: (payload: CallbackPayload) => boolean,
    timeoutMs: number
  ): Promise<CallbackPayload | null>;
  close(): Promise<void>;
};

export type CallbackObservation = { open(): Promise<CallbackSink> };

export type ScenarioEnvironment = {
  profile: Profile;
  requireControlPlaneSession: boolean;
  sandbox?: SandboxObservation;
  sessionSandbox?: SessionSandboxObservation;
  deployedHttpAuthBoundary?: DeployedAuthBoundaryObservation;
  callbacks?: CallbackObservation;
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
 * 5. otherwise run the scenario.
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

  const required = new Set<CapabilityName>([...mandatoryCapabilities(env), ...def.requires]);
  const missing = missingCapabilities([...required], env);
  if (missing.length > 0) {
    return {
      ...failed(
        `unsupported: shared scenario "${def.name}" requires unavailable capabilities: ${missing.join(', ')}`
      ),
      unsupported: true,
    };
  }

  return def.run({ ...args, api: resolvedApi.api }, env);
}
