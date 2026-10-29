import { z } from 'zod';
import {
  VercelSandboxRestClient,
  VercelSandboxRestError,
  type VercelSandboxCommand,
  type VercelSandboxRuntime,
  type VercelSandboxSnapshot,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  ByocCredentialResolverError,
  resolveByocVercelAccessConfig,
} from '../byoc/vercel-credential-resolver.js';
import { vercelSnapshotBaseImage } from '../byoc/vercel-snapshot-compatibility.js';
import type { ProviderStartupCommand } from '../sandbox-control/provider.js';
import {
  ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT,
  ENVIRONMENT_BUILD_RUNNER_ENV,
} from '../shared/environment-build-protocol.js';
import type { Env } from '../types.js';
import type {
  BuilderLaunch,
  BuilderLifecycleState,
  VercelBuilderAllocation,
} from './builder-provider.js';
import type { NativeCaptureResult } from '../sandbox-containers/SandboxContainers.js';
import {
  BuilderCreateUncertainError,
  BuilderRetryableError,
  BuilderStateInvalidError,
  BuilderTargetMismatchError,
} from './builder-errors.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';

/**
 * The Vercel side of an environment build. Vercel executes the downloaded
 * builder as a command rather than PID 1, so the builder process owns cleanup
 * (see the wrapper's owned-process scope). Snapshot creation and sandbox stop
 * are platform calls; both replies can be lost, so every mutating call is
 * preceded by an inspect/reconcile step and tracked in DO KV.
 */

export type VercelBuilderClient = Pick<
  VercelSandboxRestClient,
  | 'inspectByName'
  | 'createSandbox'
  | 'executeCommand'
  | 'getSession'
  | 'stopSession'
  | 'createSnapshot'
  | 'listCommands'
  | 'listSnapshots'
>;

export type OpenedVercelBuilder = {
  client: VercelBuilderClient;
  runtime: VercelSandboxRuntime;
  initialTimeoutMs: number;
};

const lifecycleStateSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    createRequestedAt: z.number().int().nonnegative().optional(),
    captureRequestedAt: z.number().int().nonnegative().optional(),
    captureStartedAt: z.number().int().nonnegative().optional(),
    snapshotId: z.string().min(1).optional(),
    startRequestedAt: z.number().int().nonnegative().optional(),
    started: z.boolean().optional(),
  })
  .strict();
type LifecycleState = z.infer<typeof lifecycleStateSchema>;

const TERMINAL_SESSION_STATUSES = new Set(['failed', 'aborted', 'stopping', 'stopped']);
const TERMINAL_SNAPSHOT_STATUSES = new Set(['failed', 'aborted', 'deleted']);
const MAX_BUILDER_TIMEOUT_MS = 45 * 60_000;
const START_MARKER_PREFIX = '--kilocode-envbuild-start=';

async function readState(state: BuilderLifecycleState): Promise<LifecycleState> {
  const raw = await state.get();
  if (raw === undefined) return {};
  const parsed = lifecycleStateSchema.safeParse(raw);
  if (!parsed.success) throw new BuilderStateInvalidError();
  return parsed.data;
}

function clearStateKeys(state: LifecycleState, ...keys: (keyof LifecycleState)[]): LifecycleState {
  const next = { ...state };
  for (const key of keys) delete next[key];
  return next;
}

async function writeState(
  state: BuilderLifecycleState,
  next: LifecycleState
): Promise<LifecycleState> {
  await state.set(next);
  return next;
}

function hasStatus(error: unknown, status: number): boolean {
  return error instanceof VercelSandboxRestError && error.status === status;
}

/** A definite refusal means the platform did not create anything. */
function isDefiniteRejection(error: unknown): boolean {
  return (
    error instanceof VercelSandboxRestError &&
    error.kind === 'request_failed' &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409
  );
}

function isTransient(error: unknown): boolean {
  if (error instanceof BuilderRetryableError) return true;
  if (!(error instanceof VercelSandboxRestError)) return true;
  return (
    error.status === undefined ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    error.status >= 500
  );
}

function wrapTransient(error: unknown, message: string): never {
  if (isTransient(error)) throw new BuilderRetryableError(message, { cause: error });
  throw error;
}

function timeoutMsFor(initialTimeoutMs: number, deadlineAt: number, now: number): number {
  return Math.max(
    1_000,
    Math.min(MAX_BUILDER_TIMEOUT_MS, Math.max(initialTimeoutMs, deadlineAt - now + 60_000))
  );
}

export async function openVercelBuilder(
  env: Env,
  allocation: VercelBuilderAllocation,
  fetchImpl: typeof fetch = fetch
): Promise<OpenedVercelBuilder> {
  const owner =
    allocation.owner.type === 'organization'
      ? { organizationId: allocation.owner.id }
      : { userId: allocation.owner.id };
  let config;
  try {
    config = await resolveByocVercelAccessConfig(env, {
      ...owner,
      credentialId: allocation.target.credentialId,
    });
  } catch (error) {
    if (error instanceof ByocCredentialResolverError) {
      // Resolver/network/configuration failures are transient, but a deleted
      // credential row is definitive and stays definitive.
      throw new BuilderRetryableError('Vercel credential lookup failed', { cause: error });
    }
    throw error;
  }
  if (
    config.teamId !== allocation.target.teamId ||
    config.projectId !== allocation.target.projectId
  ) {
    throw new BuilderTargetMismatchError();
  }
  return {
    client: new VercelSandboxRestClient({
      accessToken: config.accessToken,
      teamId: config.teamId,
      projectId: config.projectId,
      scope: config.scope,
      fetch: fetchImpl,
    }),
    runtime: config.runtime,
    initialTimeoutMs: config.initialTimeoutMs,
  };
}

function inspectInput(allocation: VercelBuilderAllocation, runtime: VercelSandboxRuntime) {
  return {
    name: allocation.sandboxId,
    operationId: allocation.allocationId,
    runtimeBuildId: allocation.target.runtimeBuildId,
    runtime,
    ...(allocation.target.resources ? { resources: allocation.target.resources } : {}),
    source: { type: 'snapshot' as const, snapshotId: allocation.target.baseSnapshotId },
  };
}

export async function launchVercelBuilder(input: {
  allocation: VercelBuilderAllocation;
  launch: BuilderLaunch;
  state: BuilderLifecycleState;
  client: VercelBuilderClient;
  command: ProviderStartupCommand;
  runtime: VercelSandboxRuntime;
  initialTimeoutMs: number;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  let state = await readState(input.state);

  let created;
  try {
    created = await input.client.inspectByName(inspectInput(input.allocation, input.runtime));
  } catch (error) {
    wrapTransient(error, 'Vercel builder inspect failed');
  }

  if (created === null) {
    if (state.createRequestedAt !== undefined) {
      if (now() < state.createRequestedAt + DEADLINE_MS.createSettle) {
        // A previous create may still land. Inspect again instead of creating a
        // second sandbox whose reply could be the one we lose.
        throw new BuilderRetryableError('Vercel builder create outcome is still unknown');
      }
      throw new BuilderCreateUncertainError();
    }
    state = await writeState(input.state, { ...state, createRequestedAt: now() });
    try {
      created = await input.client.createSandbox({
        ...inspectInput(input.allocation, input.runtime),
        timeoutMs: timeoutMsFor(input.initialTimeoutMs, input.launch.deadlineAt, now()),
        ...(input.allocation.target.resources
          ? { resources: input.allocation.target.resources }
          : {}),
      });
    } catch (error) {
      if (isDefiniteRejection(error)) {
        const { createRequestedAt: _requestedAt, ...rest } = state;
        await writeState(input.state, rest);
      }
      wrapTransient(error, 'Vercel builder create failed');
    }
  }

  const sessionId = created.session.id;
  state = await writeState(input.state, {
    ...clearStateKeys(state, 'createRequestedAt'),
    sessionId,
  });

  if (state.started === true) return;

  const marker = `${START_MARKER_PREFIX}${input.allocation.allocationId}`;
  if (state.startRequestedAt !== undefined) {
    let command: VercelSandboxCommand | undefined;
    try {
      command = (await input.client.listCommands(sessionId)).find(candidate =>
        candidate.args.includes(marker)
      );
    } catch (error) {
      wrapTransient(error, 'Vercel builder start reconciliation failed');
    }
    if (command !== undefined) {
      if (command.exitCode !== null) {
        throw new Error('Vercel builder exited before reporting ready');
      }
      await writeState(input.state, {
        ...clearStateKeys(state, 'startRequestedAt'),
        started: true,
      });
      return;
    }
    if (now() < state.startRequestedAt + DEADLINE_MS.createSettle) {
      throw new BuilderRetryableError('Vercel builder start outcome is still unknown');
    }
    throw new Error('Vercel builder start did not settle');
  }

  try {
    const delivery = await input.client.executeCommand(sessionId, {
      command: '/bin/sh',
      args: ['-c', ENVIRONMENT_BUILD_RUNNER_DELIVERY_SCRIPT],
      cwd: '/',
      env: { [ENVIRONMENT_BUILD_RUNNER_ENV]: JSON.stringify(input.launch.runner) },
      sudo: true,
      timeoutMs: 30_000,
      wait: true,
    });
    if (delivery.finished.exitCode !== 0) {
      throw new BuilderRetryableError('Vercel builder runner delivery failed');
    }
  } catch (error) {
    wrapTransient(error, 'Vercel builder startup failed');
  }
  const [command, ...args] = input.command.argv;
  if (!command) throw new Error('Empty builder startup command');
  args.push(marker);
  state = await writeState(input.state, { ...state, startRequestedAt: now() });
  try {
    const started = await input.client.executeCommand(sessionId, {
      command,
      args,
      cwd: '/',
      env: {},
      sudo: input.command.user === 'root',
      wait: false,
    });
    if (started.exitCode !== null) {
      throw new Error('Vercel builder exited before reporting ready');
    }
    await writeState(input.state, {
      ...clearStateKeys(state, 'startRequestedAt'),
      started: true,
    });
  } catch (error) {
    if (isDefiniteRejection(error)) {
      const { startRequestedAt: _requestedAt, ...rest } = state;
      await writeState(input.state, rest);
    }
    wrapTransient(error, 'Vercel builder startup failed');
  }
}

function snapshotResult(
  allocation: VercelBuilderAllocation,
  snapshot: VercelSandboxSnapshot,
  capturedAt: number,
  durationMs: number
): NativeCaptureResult {
  return {
    status: 'stored',
    snapshotId: snapshot.id,
    capturedAt: snapshot.createdAt ?? capturedAt,
    baseImage: vercelSnapshotBaseImage(allocation.target),
    durationMs,
  };
}

async function listSnapshotsForCapture(
  client: VercelBuilderClient
): Promise<VercelSandboxSnapshot[]> {
  try {
    return await client.listSnapshots();
  } catch (error) {
    wrapTransient(error, 'Vercel snapshot listing failed');
  }
}

async function storedFromState(
  input: {
    allocation: VercelBuilderAllocation;
    client: VercelBuilderClient;
    now: () => number;
  },
  state: LifecycleState
): Promise<NativeCaptureResult | null> {
  if (state.snapshotId === undefined) return null;
  const snapshot = (await listSnapshotsForCapture(input.client)).find(
    candidate => candidate.id === state.snapshotId
  );
  if (snapshot === undefined) {
    return input.now() - (state.captureStartedAt ?? input.now()) >= DEADLINE_MS.createSettle
      ? { status: 'failed', reason: 'snapshot_failed' }
      : { status: 'in_progress' };
  }
  if (TERMINAL_SNAPSHOT_STATUSES.has(snapshot.status)) {
    return { status: 'failed', reason: 'snapshot_failed' };
  }
  if (snapshot.status !== 'created') return { status: 'in_progress' };
  return snapshotResult(
    input.allocation,
    snapshot,
    state.captureStartedAt ?? input.now(),
    Math.max(0, input.now() - (state.captureStartedAt ?? input.now()))
  );
}

export async function captureVercelBuilder(input: {
  allocation: VercelBuilderAllocation;
  captureId: string;
  state: BuilderLifecycleState;
  client: VercelBuilderClient;
  runtime: VercelSandboxRuntime;
  now?: () => number;
}): Promise<NativeCaptureResult> {
  void input.captureId;
  const now = input.now ?? Date.now;
  let state = await readState(input.state);

  const stored = await storedFromState(
    { allocation: input.allocation, client: input.client, now },
    state
  );
  if (stored !== null) return stored;

  if (state.sessionId === undefined) {
    let inspected;
    try {
      inspected = await input.client.inspectByName(inspectInput(input.allocation, input.runtime));
    } catch (error) {
      wrapTransient(error, 'Vercel builder capture inspect failed');
    }
    if (inspected === null) return { status: 'failed', reason: 'not_running' };
    state = await writeState(input.state, { ...state, sessionId: inspected.session.id });
  }
  const sessionId = state.sessionId;
  if (sessionId === undefined) return { status: 'failed', reason: 'not_running' };

  if (state.captureRequestedAt !== undefined) {
    const candidates = (await listSnapshotsForCapture(input.client)).filter(
      snapshot => snapshot.sourceSessionId === sessionId
    );
    if (candidates.length > 1) return { status: 'failed', reason: 'uncertain' };
    const candidate = candidates[0];
    if (candidate === undefined) {
      return now() - state.captureRequestedAt >= DEADLINE_MS.createSettle
        ? { status: 'failed', reason: 'uncertain' }
        : { status: 'in_progress' };
    }
    await writeState(input.state, {
      ...clearStateKeys(state, 'captureRequestedAt'),
      snapshotId: candidate.id,
    });
    if (TERMINAL_SNAPSHOT_STATUSES.has(candidate.status)) {
      return { status: 'failed', reason: 'snapshot_failed' };
    }
    if (candidate.status !== 'created') return { status: 'in_progress' };
    return snapshotResult(
      input.allocation,
      candidate,
      state.captureStartedAt ?? now(),
      Math.max(0, now() - (state.captureStartedAt ?? now()))
    );
  }

  state = await writeState(input.state, {
    ...state,
    captureRequestedAt: now(),
    captureStartedAt: now(),
  });
  let snapshot: VercelSandboxSnapshot;
  try {
    snapshot = await input.client.createSnapshot(sessionId);
  } catch (error) {
    if (isDefiniteRejection(error)) {
      const { captureRequestedAt: _requestedAt, ...rest } = state;
      await writeState(input.state, rest);
      return { status: 'failed', reason: 'snapshot_failed' };
    }
    wrapTransient(error, 'Vercel snapshot request failed');
  }
  await writeState(input.state, {
    ...clearStateKeys(state, 'captureRequestedAt'),
    snapshotId: snapshot.id,
  });
  if (snapshot.status !== 'created') return { status: 'in_progress' };
  return snapshotResult(
    input.allocation,
    snapshot,
    state.captureStartedAt ?? now(),
    Math.max(0, now() - (state.captureStartedAt ?? now()))
  );
}

export async function stopVercelBuilder(input: {
  allocation: VercelBuilderAllocation;
  state: BuilderLifecycleState;
  client: VercelBuilderClient;
  runtime: VercelSandboxRuntime;
  now?: () => number;
}): Promise<'terminal' | 'retryable'> {
  const now = input.now ?? Date.now;
  const state = await readState(input.state);
  let sessionId = state.sessionId;
  if (sessionId === undefined) {
    let inspected;
    try {
      inspected = await input.client.inspectByName(inspectInput(input.allocation, input.runtime));
    } catch (error) {
      wrapTransient(error, 'Vercel builder stop inspect failed');
    }
    if (inspected === null) {
      if (
        state.createRequestedAt !== undefined &&
        now() < state.createRequestedAt + DEADLINE_MS.createSettle
      ) {
        // The create POST may still land; terminal now could orphan a sandbox.
        return 'retryable';
      }
      await input.state.clear();
      return 'terminal';
    }
    sessionId = inspected.session.id;
    await writeState(input.state, { ...state, sessionId });
  }

  try {
    const session = await input.client.getSession(sessionId, input.allocation.sandboxId);
    if (TERMINAL_SESSION_STATUSES.has(session.session.status)) {
      await input.state.clear();
      return 'terminal';
    }
    await input.client.stopSession(sessionId, input.allocation.sandboxId);
    await input.state.clear();
    return 'terminal';
  } catch (error) {
    if (hasStatus(error, 404)) {
      await input.state.clear();
      return 'terminal';
    }
    if (isTransient(error)) return 'retryable';
    throw error;
  }
}
