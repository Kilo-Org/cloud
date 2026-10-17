import { CONTROL_SUPERVISOR_PATH } from './container-paths.js';
import { sha256Hex } from './runtime-artifact-store.js';
import {
  RUNTIME_ARTIFACT_GRANT_SECONDS,
  mintRuntimeArtifactGrant,
} from './runtime-artifact-grant.js';
import {
  RUNTIME_INSTALLER_FAILURE_REASONS,
  RuntimeInstallerError,
  loadRuntimeRelease,
  runtimeInstallerReasonForCode,
  type RuntimeArtifactReader,
  type RuntimeInstallerFailureReason,
} from './runtime-release-loader.js';
import {
  RUNTIME_ARTIFACT_GRANT_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_DESCRIPTOR_ENV,
  runtimeLaunchCommand,
} from './runtime-bootstrap.js';
import {
  reconcileRuntimeLaunch,
  type RuntimeLaunchObservation,
  type RuntimeLaunchOutcome,
  type RuntimeLaunchPhaseClock,
} from './runtime-launch-phase.js';
import {
  RUNTIME_BOOTSTRAP_CONTRACT,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  parseRuntimeRelease,
  parseTrustedRuntimeArtifactOrigin,
  runtimeArtifactHashes,
  type RuntimeReleaseDescriptor,
} from '../shared/runtime-release.js';
import { z } from 'zod';

/**
 * The common cold-runtime launch workflow. It owns selection consumption, the
 * artifact preflight, the short read grant, command rendering, receipt-first
 * classification, guarded settlement then acknowledgement, and snapshot
 * fallback. It imports no Cloudflare platform API and sees no SDK DTO.
 */

export type RuntimeLaunchProviderStartSource = 'image' | 'repository';

const runtimeDescriptorSchema = z.string().superRefine((value, ctx) => {
  if (new TextEncoder().encode(value).byteLength > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime descriptor exceeds the byte cap',
    });
    return;
  }
  try {
    parseRuntimeRelease(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime descriptor does not match the release schema',
    });
  }
});

const runtimeArtifactOriginSchema = z
  .string()
  .refine(
    value => parseTrustedRuntimeArtifactOrigin(value) !== null,
    'runtime artifact origin must be a bare HTTPS origin'
  );

export const runtimeLaunchSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baked') }).strict(),
  z
    .object({
      kind: z.literal('release'),
      descriptor: runtimeDescriptorSchema,
      artifactOrigin: runtimeArtifactOriginSchema,
      bootstrapContract: z.literal(RUNTIME_BOOTSTRAP_CONTRACT),
    })
    .strict(),
]);
export type RuntimeLaunchSelection = z.infer<typeof runtimeLaunchSelectionSchema>;

/**
 * Choose the launch selection ONCE from Worker configuration. Both absent is the
 * baked selection; anything else must be a complete, valid release or this
 * throws, so a malformed explicit configuration fails closed instead of
 * silently selecting baked.
 */
export function resolveRuntimeLaunchSelection(config: {
  descriptor: string | undefined;
  artifactOrigin: string | undefined;
}): RuntimeLaunchSelection {
  const descriptor =
    config.descriptor !== undefined && config.descriptor.trim() !== ''
      ? config.descriptor
      : undefined;
  const origin = parseTrustedRuntimeArtifactOrigin(config.artifactOrigin);
  if (descriptor === undefined && origin === null) return { kind: 'baked' };
  return runtimeLaunchSelectionSchema.parse({
    kind: 'release',
    descriptor,
    artifactOrigin: origin,
    bootstrapContract: RUNTIME_BOOTSTRAP_CONTRACT,
  });
}

export type RuntimeLaunchIdentity = {
  descriptorSha256: string;
  cliSha256: string;
  controlSha256: string;
};

export type RuntimeReserveInput = {
  allocationId: string;
  /** The persisted physical nonce; the provider reserves it, never mints another. */
  launchId: string;
  /** Outer allocation deadline from SQL; the attempt bound may not exceed it. */
  outerDeadlineAt: number;
  repoKey?: string;
  skipRepository?: true;
  runtimeIdentity?: RuntimeLaunchIdentity;
};

/**
 * The recorded workflow phase a reservation reports.
 *
 * - `reserved`: no start decision yet; the caller runs preflight and start.
 * - `issued`: a start decision was recorded (issued, ambiguous, or a confirmed
 *   physical rejection); the caller replays `start` and never reissues.
 * - `settled`: the exact typed outcome is durable; the caller returns it.
 */
export type RuntimeReservePhase = 'reserved' | 'issued' | 'settled';

export type RuntimeReserveResult =
  | {
      kind: 'reserved';
      phase: 'reserved';
      providerRef: string;
      startSource: RuntimeLaunchProviderStartSource;
      attemptDeadlineAt: number;
    }
  | {
      kind: 'reserved';
      phase: 'issued';
      providerRef: string;
      startSource: RuntimeLaunchProviderStartSource;
      attemptDeadlineAt: number;
      /** The exact recorded mechanical start result; replay it, never reissue. */
      start: RuntimeStartResult;
    }
  | {
      kind: 'reserved';
      phase: 'settled';
      providerRef: string;
      startSource: RuntimeLaunchProviderStartSource;
      attemptDeadlineAt: number;
      /** The exact typed outcome, replayed unchanged after an ACK or crash. */
      outcome: RuntimeLaunchResult;
    }
  /** A definite refusal: this nonce no longer owns the allocation. Recoverable. */
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable'; reason: string };

export type RuntimeStartInput = {
  allocationId: string;
  launchId: string;
  providerRef: string;
  /** The rendered startup command, run as the initial process (PID 1). */
  command: string;
  /** Non-persistent launch env. Any grant/descriptor/origin travel in `command`. */
  env: Record<string, string>;
  attemptDeadlineAt: number;
  failureRetention: boolean;
};

/**
 * `issued` is an accepted start; `unknown` is an issued-or-not outcome that must
 * be reconciled, never reissued; only `snapshot-failed` is a confirmed physical
 * restore/start rejection that may select image fallback. `refused` is a
 * definite loss of ownership, which ends observation at once.
 */
export type RuntimeStartResult =
  | { kind: 'issued' }
  | { kind: 'snapshot-failed' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'refused'; reason: string };

export type RuntimeLaunchOps = {
  reserveLaunch(input: RuntimeReserveInput): Promise<RuntimeReserveResult>;
  startLaunch(input: RuntimeStartInput): Promise<RuntimeStartResult>;
  /** One normalized observation; the shared phase code parses receipts. */
  observeLaunch(input: {
    providerRef: string;
    launchId: string;
    deadlineAt: number;
  }): Promise<RuntimeLaunchObservation>;
  /** Persist the classified result under the token guard. False means stale/lost. */
  settleLaunch(input: { launchId: string; result: RuntimeLaunchResult }): Promise<boolean>;
  /** Delete the exact retained receipt (acknowledgement). Idempotent. */
  acknowledgeLaunch(input: { launchId: string; receipt?: string }): Promise<void>;
  /** Retire and clean a reservation that never started. Idempotent. */
  retireLaunch(input: {
    providerRef: string;
    launchId: string;
    outerDeadlineAt: number;
  }): Promise<void>;
  /** Confirmed destruction for a fallback or admission failure. */
  destroyLaunch(input: {
    providerRef: string;
    launchId: string;
    outerDeadlineAt: number;
  }): Promise<boolean>;
};

export type RuntimeLaunchEffects = {
  /** Resolve the artifact-read signing secret, or null when unavailable. */
  grantSecret: () => Promise<string | null>;
  /**
   * Owner-guarded commit of the reserved provider ref before slow preflight.
   * False means the owner already retired this token: clean the reservation and
   * never start. The phase lets the owner skip credential churn on reentry.
   */
  onReserved: (
    input: {
      providerRef: string;
      startSource: RuntimeLaunchProviderStartSource;
      attemptDeadlineAt: number;
      phase: RuntimeReservePhase;
    },
    launchId: string
  ) => Promise<boolean>;
  /**
   * Owner-guarded forced-image fallback after confirmed destruction. It returns
   * a fresh nonce and the replacement wrapper launch env. Absent means no
   * fallback is permitted.
   */
  rotateFallbackNonce?: (input: {
    previousLaunchId: string;
    outerDeadlineAt: number;
  }) => Promise<{ launchId: string; launchEnv: Record<string, string> }>;
};

export type RuntimeLaunchRequest = {
  /** Absent means no runtime execution support; an explicit release then fails before physical work. */
  ops?: RuntimeLaunchOps;
  selection: RuntimeLaunchSelection;
  allocationId: string;
  launchId: string;
  /** Outer allocation deadline. The attempt bound may never exceed it. */
  outerDeadlineAt: number;
  reader: RuntimeArtifactReader;
  effects: RuntimeLaunchEffects;
  launchEnv: Record<string, string>;
  repoKey?: string;
  skipRepository?: true;
  failureRetention?: boolean;
  clock?: RuntimeLaunchPhaseClock;
};

export type RuntimeLaunchResult =
  | { kind: 'handoff'; startSource: RuntimeLaunchProviderStartSource }
  | { kind: 'snapshot-failed' }
  | { kind: 'installer-failed'; reason: RuntimeInstallerFailureReason }
  | { kind: 'deadline' }
  | { kind: 'unsupported-release' }
  | { kind: 'reservation-failed'; reason: string }
  | { kind: 'ownership-lost' }
  | { kind: 'bootstrap-failed' };

const INSTALLER_FAILURE_REASONS: readonly string[] = RUNTIME_INSTALLER_FAILURE_REASONS;

/** Strict decode of a persisted typed launch result. Unknown shapes are rejected. */
export function parseRuntimeLaunchResult(value: unknown): RuntimeLaunchResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'handoff':
      if (record.startSource !== 'image' && record.startSource !== 'repository') return undefined;
      return { kind: 'handoff', startSource: record.startSource };
    case 'snapshot-failed':
      return { kind: 'snapshot-failed' };
    case 'deadline':
      return { kind: 'deadline' };
    case 'unsupported-release':
      return { kind: 'unsupported-release' };
    case 'ownership-lost':
      return { kind: 'ownership-lost' };
    case 'bootstrap-failed':
      return { kind: 'bootstrap-failed' };
    case 'installer-failed':
      if (typeof record.reason !== 'string' || !INSTALLER_FAILURE_REASONS.includes(record.reason)) {
        return undefined;
      }
      return { kind: 'installer-failed', reason: record.reason as RuntimeInstallerFailureReason };
    case 'reservation-failed':
      if (typeof record.reason !== 'string' || record.reason === '') return undefined;
      return { kind: 'reservation-failed', reason: record.reason };
    default:
      return undefined;
  }
}

/** Strict decode of a persisted mechanical start result. Unknown shapes are rejected. */
export function parseRuntimeStartResult(value: unknown): RuntimeStartResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'issued':
      return { kind: 'issued' };
    case 'snapshot-failed':
      return { kind: 'snapshot-failed' };
    case 'unknown':
    case 'refused':
      if (typeof record.reason !== 'string' || record.reason === '') return undefined;
      return { kind: record.kind, reason: record.reason };
    default:
      return undefined;
  }
}

type PreparedRelease = {
  descriptor: string;
  origin: string;
  hashes: [string, string];
};

type PreparedLaunch =
  | { kind: 'failed'; result: RuntimeLaunchResult }
  | { kind: 'ready'; release?: PreparedRelease; grant?: string };

/** Single-quote shell escaping so a value is one literal word in the command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The baked startup command: the canonical supervisor as PID 1, no installer. */
export function bakedLaunchCommand(): string {
  return `exec /bin/sh ${CONTROL_SUPERVISOR_PATH}`;
}

/**
 * The release startup command: the shared launch command with the descriptor,
 * origin and grant inlined as exported environment values. The values travel in
 * the command text and are never persisted to a startup environment.
 */
export function runtimeLaunchStartCommand(input: {
  launchId: string;
  deadlineAt: number;
  failureRetention: boolean;
  descriptor: string;
  origin: string;
  grant: string;
}): string {
  const prelude = [
    `export ${RUNTIME_DESCRIPTOR_ENV}=${shellQuote(input.descriptor)}`,
    `export ${RUNTIME_ARTIFACT_ORIGIN_ENV}=${shellQuote(input.origin)}`,
    `export ${RUNTIME_ARTIFACT_GRANT_ENV}=${shellQuote(input.grant)}`,
  ];
  const command = runtimeLaunchCommand({
    launchId: input.launchId,
    deadlineAt: input.deadlineAt,
    failureRetention: input.failureRetention,
  });
  const rendered = `${prelude.join('\n')}\n${command}`;
  if (new TextEncoder().encode(rendered).byteLength >= 128 * 1024)
    throw new RuntimeInstallerError(
      'runtime_artifact_integrity',
      'Runtime bootstrap command exceeds the Linux single-argument limit'
    );
  return rendered;
}

function renderCommand(
  selection: RuntimeLaunchSelection,
  launchId: string,
  deadlineAt: number,
  failureRetention: boolean,
  grant: string | undefined
): string {
  if (selection.kind === 'baked') return bakedLaunchCommand();
  if (grant === undefined) throw new Error('release launch requires an artifact grant');
  return runtimeLaunchStartCommand({
    launchId,
    deadlineAt,
    failureRetention,
    descriptor: selection.descriptor,
    origin: selection.artifactOrigin,
    grant,
  });
}

function clampAttemptDeadline(attemptDeadlineAt: number, outerDeadlineAt: number): number {
  return Math.min(attemptDeadlineAt, outerDeadlineAt);
}

function computeGrantTtlSeconds(deadlineAt: number, now: number): number {
  return Math.min(
    RUNTIME_ARTIFACT_GRANT_SECONDS,
    Math.max(1, Math.floor((deadlineAt - now) / 1000))
  );
}

async function mintGrant(
  request: RuntimeLaunchRequest,
  hashes: [string, string],
  deadlineAt: number
): Promise<string | null> {
  const secret = await request.effects.grantSecret();
  if (secret === null) return null;
  return mintRuntimeArtifactGrant(
    { hashes, allocationId: request.allocationId },
    secret,
    computeGrantTtlSeconds(deadlineAt, Date.now())
  );
}

/** Preflight a release selection, or admit baked with no installer and no grant. */
async function prepareLaunch(
  request: RuntimeLaunchRequest,
  deadlineAt: number
): Promise<PreparedLaunch> {
  if (request.selection.kind === 'baked') return { kind: 'ready' };
  const { descriptor, artifactOrigin: origin } = request.selection;
  let loaded: RuntimeReleaseDescriptor | null;
  try {
    loaded = await loadRuntimeRelease({
      reader: request.reader,
      descriptor,
      deadlineAt,
    });
  } catch (error) {
    if (error instanceof RuntimeInstallerError) {
      return { kind: 'failed', result: { kind: 'installer-failed', reason: error.reason } };
    }
    return { kind: 'failed', result: { kind: 'bootstrap-failed' } };
  }
  if (loaded === null) {
    return {
      kind: 'failed',
      result: { kind: 'installer-failed', reason: 'runtime_artifact_missing' },
    };
  }
  const hashes = runtimeArtifactHashes(loaded);
  const grant = await mintGrant(request, hashes, deadlineAt);
  if (grant === null) {
    return {
      kind: 'failed',
      result: { kind: 'installer-failed', reason: 'runtime_artifact_unavailable' },
    };
  }
  return { kind: 'ready', release: { descriptor, origin, hashes }, grant };
}

function classifyOutcome(
  outcome: RuntimeLaunchOutcome,
  startSource: RuntimeLaunchProviderStartSource
): RuntimeLaunchResult {
  if (outcome.kind === 'handoff') return { kind: 'handoff', startSource };
  if (outcome.kind === 'installer-failed') {
    return { kind: 'installer-failed', reason: runtimeInstallerReasonForCode(outcome.code) };
  }
  if (outcome.kind === 'deadline') return { kind: 'deadline' };
  if (outcome.kind === 'ownership-lost') return { kind: 'ownership-lost' };
  return { kind: 'bootstrap-failed' };
}

export class RuntimeLaunchSettlementError extends Error {
  constructor(readonly outcome: RuntimeLaunchResult) {
    super('Native launch outcome persistence could not be confirmed');
    this.name = 'RuntimeLaunchSettlementError';
  }
}

/** Persist a decided outcome under the token guard; a lost token is ownership-lost. */
async function settleOutcome(
  ops: RuntimeLaunchOps,
  launchId: string,
  result: RuntimeLaunchResult
): Promise<RuntimeLaunchResult> {
  try {
    const settled = await ops.settleLaunch({ launchId, result });
    return settled ? result : { kind: 'ownership-lost' };
  } catch {
    throw new RuntimeLaunchSettlementError(result);
  }
}

/**
 * Start once (or replay a recorded decision), reconcile by observation under the
 * same nonce and deadline, then settle and acknowledge any observed receipt. A
 * start is never repeated here; a definite refusal ends at once.
 */
async function runAttempt(input: {
  request: RuntimeLaunchRequest;
  ops: RuntimeLaunchOps;
  launchId: string;
  providerRef: string;
  startSource: RuntimeLaunchProviderStartSource;
  attemptDeadlineAt: number;
  env: Record<string, string>;
  /** A recorded mechanical start from a reentry; skips the physical start. */
  decision?: RuntimeStartResult;
  /** The rendered startup command; required only when issuing a fresh start. */
  command?: string;
  failureRetention: boolean;
}): Promise<RuntimeLaunchResult> {
  const { request, ops } = input;
  const started =
    input.decision ??
    (await ops.startLaunch({
      allocationId: request.allocationId,
      launchId: input.launchId,
      providerRef: input.providerRef,
      command: input.command ?? '',
      env: input.env,
      attemptDeadlineAt: input.attemptDeadlineAt,
      failureRetention: input.failureRetention,
    }));
  // A definite refusal ends at once: no observation, no poll to the bound.
  if (started.kind === 'refused')
    return started.reason === 'deadline'
      ? settleOutcome(ops, input.launchId, { kind: 'deadline' })
      : { kind: 'ownership-lost' };
  if (started.kind === 'snapshot-failed') return { kind: 'snapshot-failed' };

  const reconciliation = await reconcileRuntimeLaunch({
    observe: observeInput => ops.observeLaunch(observeInput),
    providerRef: input.providerRef,
    launchId: input.launchId,
    deadlineAt: input.attemptDeadlineAt,
    requireHandoffReceipt: request.selection.kind === 'release',
    clock: request.clock,
  });
  const result = classifyOutcome(reconciliation.outcome, input.startSource);
  // A retired token owns nothing: do not settle a replacement's record.
  if (result.kind === 'ownership-lost') return result;

  // Guarded durable settlement is required before acknowledgement.
  const settled = await settleOutcome(ops, input.launchId, result);
  if (settled.kind === 'ownership-lost') return settled;

  // Acknowledge only an observed current receipt, so a stale receipt does not
  // accumulate and no receipt is ever deleted without matching evidence.
  if (reconciliation.receipt !== undefined) {
    try {
      await ops.acknowledgeLaunch({
        launchId: input.launchId,
        receipt: reconciliation.receipt,
      });
    } catch {
      // A failed acknowledgement never changes the settled outcome.
    }
  }
  return result;
}

/**
 * Run the common cold-runtime workflow. It reserves ownership before any slow
 * preflight, replays a recorded issuance or settlement without repeating
 * physical work, never starts on an expired attempt bound, never silently
 * substitutes baked for an explicit release, and only a confirmed physical
 * snapshot failure permits one image fallback.
 */
export async function launchSandbox(request: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
  const ops = request.ops;
  // Presence of concrete runtime execution ops denotes support. An explicit
  // release with no ops fails before any reservation or physical work.
  if (ops === undefined) return { kind: 'unsupported-release' };
  let runtimeIdentity: RuntimeLaunchIdentity | undefined;
  if (request.selection.kind === 'release') {
    try {
      const descriptor = parseRuntimeRelease(request.selection.descriptor);
      const [cliSha256, controlSha256] = runtimeArtifactHashes(descriptor);
      runtimeIdentity = {
        descriptorSha256: await sha256Hex(new TextEncoder().encode(request.selection.descriptor)),
        cliSha256,
        controlSha256,
      };
    } catch {
      // Preflight owns malformed-selection failures; evidence cannot change them.
    }
  }

  const failureRetention = request.failureRetention === true;

  // Reserve ownership FIRST, before slow preflight or grant/billing, so a Stop
  // before or during preflight can fence the reservation.
  const reserved = await ops.reserveLaunch({
    allocationId: request.allocationId,
    launchId: request.launchId,
    outerDeadlineAt: request.outerDeadlineAt,
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    ...(request.repoKey === undefined ? {} : { repoKey: request.repoKey }),
    ...(request.skipRepository === true ? { skipRepository: true as const } : {}),
  });
  if (reserved.kind === 'refused' || reserved.kind === 'unavailable') {
    return reserved.reason === 'deadline'
      ? { kind: 'deadline' }
      : { kind: 'reservation-failed', reason: reserved.reason };
  }
  const attemptDeadlineAt = clampAttemptDeadline(
    reserved.attemptDeadlineAt,
    request.outerDeadlineAt
  );

  // The owner guard runs on every phase; `phase` lets it avoid credential churn
  // on an issued or settled reentry.
  const committed = await request.effects.onReserved(
    {
      providerRef: reserved.providerRef,
      startSource: reserved.startSource,
      attemptDeadlineAt,
      phase: reserved.phase,
    },
    request.launchId
  );
  if (!committed) {
    // The owner already retired this token: clean our own reservation so it can
    // never start later, then report the loss.
    return abandonReservation(ops, reserved.providerRef, request.launchId, request.outerDeadlineAt);
  }

  // A settled reentry replays the exact stored outcome without any preflight,
  // grant, command or start.
  if (reserved.phase === 'settled') return reserved.outcome;

  const decision: RuntimeStartResult | undefined =
    reserved.phase === 'issued' ? reserved.start : undefined;
  if (decision !== undefined && decision.kind === 'refused') return { kind: 'ownership-lost' };

  let prepared: PreparedLaunch = { kind: 'ready' };
  let result: RuntimeLaunchResult;
  if (decision !== undefined && decision.kind !== 'snapshot-failed') {
    // An issued or ambiguous reentry skips preflight, grant, command and start
    // and reconciles under the same bound; the physical start is never repeated.
    result = await runAttempt({
      request,
      ops,
      launchId: request.launchId,
      providerRef: reserved.providerRef,
      startSource: reserved.startSource,
      attemptDeadlineAt,
      env: request.launchEnv,
      decision,
      failureRetention,
    });
  } else if (decision !== undefined) {
    // A recorded physical rejection is replayed, never reissued.
    result = { kind: 'snapshot-failed' };
  } else {
    // Never do physical work on an already-expired attempt bound: persist the
    // deadline result and stop. Rechecked after the owner guard so a slow guard
    // cannot let an aged-out reservation start.
    if (Date.now() >= attemptDeadlineAt) {
      return settleOutcome(ops, request.launchId, { kind: 'deadline' });
    }
    prepared = await prepareLaunch(request, attemptDeadlineAt);
    if (prepared.kind === 'failed') return settleOutcome(ops, request.launchId, prepared.result);
    result = await runAttempt({
      request,
      ops,
      launchId: request.launchId,
      providerRef: reserved.providerRef,
      startSource: reserved.startSource,
      attemptDeadlineAt,
      env: request.launchEnv,
      command: renderCommand(
        request.selection,
        request.launchId,
        attemptDeadlineAt,
        failureRetention,
        prepared.grant
      ),
      failureRetention,
    });
  }

  // Only a confirmed physical snapshot/start rejection may fall back, once, under
  // the unchanged outer deadline. A typed installer failure never falls back.
  if (
    result.kind === 'snapshot-failed' &&
    request.skipRepository !== true &&
    request.effects.rotateFallbackNonce !== undefined
  ) {
    // The fallback image attempt needs the preflight hashes for its grant. A
    // replayed rejection skipped preflight, so prepare it now if required.
    let release = prepared.kind === 'ready' ? prepared.release : undefined;
    if (release === undefined && request.selection.kind === 'release') {
      const reprepared = await prepareLaunch(request, attemptDeadlineAt);
      if (reprepared.kind === 'failed')
        return settleOutcome(ops, request.launchId, reprepared.result);
      release = reprepared.release;
    }

    const destroyed = await ops.destroyLaunch({
      providerRef: reserved.providerRef,
      launchId: request.launchId,
      outerDeadlineAt: request.outerDeadlineAt,
    });
    if (!destroyed) return { kind: 'snapshot-failed' };

    const rotated = await request.effects.rotateFallbackNonce({
      previousLaunchId: request.launchId,
      outerDeadlineAt: request.outerDeadlineAt,
    });
    const imageReserve = await ops.reserveLaunch({
      allocationId: request.allocationId,
      launchId: rotated.launchId,
      outerDeadlineAt: request.outerDeadlineAt,
      ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
      skipRepository: true,
    });
    if (imageReserve.kind === 'refused' || imageReserve.kind === 'unavailable') {
      return imageReserve.reason === 'deadline'
        ? { kind: 'deadline' }
        : { kind: 'reservation-failed', reason: imageReserve.reason };
    }
    const imageDeadlineAt = clampAttemptDeadline(
      imageReserve.attemptDeadlineAt,
      request.outerDeadlineAt
    );
    const imageCommitted = await request.effects.onReserved(
      {
        providerRef: imageReserve.providerRef,
        startSource: imageReserve.startSource,
        attemptDeadlineAt: imageDeadlineAt,
        phase: imageReserve.phase,
      },
      rotated.launchId
    );
    if (!imageCommitted)
      return abandonReservation(
        ops,
        imageReserve.providerRef,
        rotated.launchId,
        request.outerDeadlineAt
      );
    if (imageReserve.phase === 'settled') return imageReserve.outcome;
    const imageDecision = imageReserve.phase === 'issued' ? imageReserve.start : undefined;
    if (imageDecision !== undefined && imageDecision.kind === 'refused') {
      return { kind: 'ownership-lost' };
    }
    if (imageDecision === undefined && Date.now() >= imageDeadlineAt) {
      return settleOutcome(ops, rotated.launchId, { kind: 'deadline' });
    }

    let imageGrant: string | undefined;
    if (release !== undefined) {
      const minted = await mintGrant(request, release.hashes, imageDeadlineAt);
      if (minted === null) {
        return settleOutcome(ops, rotated.launchId, {
          kind: 'installer-failed',
          reason: 'runtime_artifact_unavailable',
        });
      }
      imageGrant = minted;
    }

    result = await runAttempt({
      request,
      ops,
      launchId: rotated.launchId,
      providerRef: imageReserve.providerRef,
      startSource: imageReserve.startSource,
      attemptDeadlineAt: imageDeadlineAt,
      env: rotated.launchEnv,
      ...(imageDecision === undefined ? {} : { decision: imageDecision }),
      command: renderCommand(
        request.selection,
        rotated.launchId,
        imageDeadlineAt,
        failureRetention,
        imageGrant
      ),
      failureRetention,
    });
  }

  return result;
}

async function abandonReservation(
  ops: RuntimeLaunchOps,
  providerRef: string,
  launchId: string,
  outerDeadlineAt: number
): Promise<RuntimeLaunchResult> {
  await ops.retireLaunch({ providerRef, launchId, outerDeadlineAt }).catch(() => undefined);
  return { kind: 'ownership-lost' };
}
