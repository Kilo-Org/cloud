import { z } from 'zod';
import { RUNTIME_RESERVED_ROOT } from '../shared/runtime-distribution.js';
import {
  RUNTIME_LAUNCH_ID_PATTERN,
  RUNTIME_LAUNCH_RECEIPT_MAX_BYTES,
  runtimeLaunchReceiptDir,
  runtimeLaunchReceiptPath,
} from '../sandbox-control/runtime-launch-receipt.js';
import {
  RUNTIME_ARTIFACT_GRANT_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_DESCRIPTOR_ENV,
} from '../sandbox-control/runtime-bootstrap.js';
import { classifyMainProcess } from './main-process.js';
import {
  parseRuntimeLaunchResult,
  parseRuntimeStartResult,
  type RuntimeLaunchResult,
  type RuntimeLaunchIdentity,
  type RuntimeReserveInput,
  type RuntimeStartInput,
  type RuntimeStartResult,
} from '../sandbox-control/runtime-launch.js';
import type {
  RuntimeLaunchObservation,
  RuntimeLaunchProcessObservation,
} from '../sandbox-control/runtime-launch-phase.js';

/**
 * Native launch support: ownership reservation, issuance fences, bounded
 * retirement and the durable settlement mechanism the common workflow drives.
 * It is not a second installer/startup orchestrator. Everything here is pure or
 * host-neutral: the native Durable Object owns the container, storage and
 * billing calls, and this module owns the decisions it makes about them.
 */

/** Fixed cap on live retirement fences. Saturation is refused, never evicted. */
export const NATIVE_RETIREMENT_CAP = 32;
export const nativeRuntimeProtocolSchema = z.literal(1).optional();

/** Physical attempt budget from the first reservation, per start source. */
export const NATIVE_IMAGE_ATTEMPT_MS = 90_000;
export const NATIVE_REPOSITORY_ATTEMPT_MS = 300_000;

/** Label stamped on a native start so `inspect()` can corroborate the nonce. */
export const NATIVE_LAUNCH_LABEL = 'kilocode.launch';

/** One retired launch nonce, kept until the outer allocation deadline. */
export type NativeRetirementFence = { launchId: string; until: number };

export type NativeLaunchToken = { launchId: string; createDeadlineAt: number };

/** The base identity a launch was actually bound to at reservation. */
export type NativeLaunchSource =
  | { kind: 'resolving'; image: string; repoKey?: string; skipRepository: boolean }
  | { kind: 'image'; image: string }
  | {
      kind: 'repository';
      image: string;
      snapshotId: string;
      indexKey: string;
    };

/** The common-classified outcome persisted before any acknowledgement. */
export type NativeLaunchSettlement = { result: RuntimeLaunchResult; at: number };
const nativeStopEvidenceSchema = z
  .object({
    allocationId: z.string().min(1).max(128),
    launchId: z.string().regex(RUNTIME_LAUNCH_ID_PATTERN),
    confirmedAt: z.number().int(),
  })
  .strict();
export type NativeStopEvidence = z.infer<typeof nativeStopEvidenceSchema>;

/**
 * The native evidence persisted inside the grouped `containers:record:v1`. It
 * mirrors the issuance identity and outcome; it is never a second authoritative
 * runtime selection or allocation lifecycle.
 */
export type NativeLaunchRecord = {
  allocationId: string;
  launchId: string;
  outerDeadlineAt: number;
  firstReservationAt: number;
  attemptDeadlineAt: number;
  source: NativeLaunchSource;
  runtimeIdentity?: RuntimeLaunchIdentity;
  /** Interception plus injected CA is installed before the first Bun process. */
  interception: boolean;
  /** Present once the supplied command was handed to the container runtime. */
  issuedAt?: number;
  /** The recorded mechanical start decision; replayed, never reissued. */
  start?: RuntimeStartResult;
  /** The common-classified outcome, persisted before any acknowledgement. */
  settled?: NativeLaunchSettlement;
  acked?: true;
};

const nativeLaunchSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resolving'),
      image: z.string().min(1),
      repoKey: z.string().min(1).optional(),
      skipRepository: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('image'), image: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('repository'),
      image: z.string().min(1),
      snapshotId: z.string().min(1),
      indexKey: z.string().min(1),
    })
    .strict(),
]);

const nativeLaunchRecordShape = z
  .object({
    allocationId: z.string().min(1),
    launchId: z.string().regex(RUNTIME_LAUNCH_ID_PATTERN),
    outerDeadlineAt: z.number().int(),
    firstReservationAt: z.number().int(),
    attemptDeadlineAt: z.number().int(),
    source: nativeLaunchSourceSchema,
    runtimeIdentity: z
      .object({
        descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
        cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
        controlSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    interception: z.boolean(),
    issuedAt: z.number().int().optional(),
    // The exact typed results are re-parsed with their strict decoders below.
    start: z.unknown().optional(),
    settled: z.object({ result: z.unknown(), at: z.number().int() }).strict().optional(),
    acked: z.literal(true).optional(),
  })
  .strict();

export type NativeLaunchRecordRead =
  | { kind: 'absent' }
  | { kind: 'valid'; record: NativeLaunchRecord }
  | { kind: 'invalid' };

/**
 * Strict decode of persisted native evidence. Absent is a legacy record that
 * retains baked reconciliation. A present but malformed value is `invalid`: the
 * caller must fail closed and do no physical work, never downgrade to legacy.
 */
export function readNativeLaunchRecord(value: unknown): NativeLaunchRecordRead {
  if (value === undefined) return { kind: 'absent' };
  const parsed = nativeLaunchRecordShape.safeParse(value);
  if (!parsed.success) return { kind: 'invalid' };
  const data = parsed.data;
  if (
    data.source.kind === 'resolving' &&
    (data.start !== undefined || data.issuedAt !== undefined || data.settled !== undefined)
  )
    return { kind: 'invalid' };
  let start: RuntimeStartResult | undefined;
  if (data.start !== undefined) {
    start = parseRuntimeStartResult(data.start);
    if (start === undefined) return { kind: 'invalid' };
  }
  let settled: NativeLaunchSettlement | undefined;
  if (data.settled !== undefined) {
    const result = parseRuntimeLaunchResult(data.settled.result);
    if (result === undefined) return { kind: 'invalid' };
    settled = { result, at: data.settled.at };
  }
  return {
    kind: 'valid',
    record: {
      allocationId: data.allocationId,
      launchId: data.launchId,
      outerDeadlineAt: data.outerDeadlineAt,
      firstReservationAt: data.firstReservationAt,
      attemptDeadlineAt: data.attemptDeadlineAt,
      source: data.source,
      ...(data.runtimeIdentity === undefined ? {} : { runtimeIdentity: data.runtimeIdentity }),
      interception: data.interception,
      ...(data.issuedAt === undefined ? {} : { issuedAt: data.issuedAt }),
      ...(start === undefined ? {} : { start }),
      ...(settled === undefined ? {} : { settled }),
      ...(data.acked === undefined ? {} : { acked: data.acked }),
    },
  };
}

/** Evidence-only view: a malformed record reads as absent. Never gates operations. */
export function parseNativeLaunchRecord(value: unknown): NativeLaunchRecord | undefined {
  const read = readNativeLaunchRecord(value);
  return read.kind === 'valid' ? read.record : undefined;
}

const nativeRetirementsSchema = z.array(
  z
    .object({
      launchId: z.string().regex(RUNTIME_LAUNCH_ID_PATTERN),
      until: z.number().int(),
    })
    .strict()
);

export type NativeRetirementsRead =
  | { kind: 'absent' }
  | { kind: 'valid'; fences: NativeRetirementFence[] }
  | { kind: 'saturated'; fences: NativeRetirementFence[] }
  | { kind: 'invalid' };

/**
 * Strict decode of persisted retirement fences. An absent value is empty; a
 * present value that is malformed is `invalid` and a well-formed value over the
 * cap is `saturated`, so a corrupt or over-cap set can never silently drop a live
 * fence.
 */
export function readRetirements(value: unknown): NativeRetirementsRead {
  if (value === undefined) return { kind: 'absent' };
  const parsed = nativeRetirementsSchema.safeParse(value);
  if (!parsed.success) return { kind: 'invalid' };
  if (parsed.data.length > NATIVE_RETIREMENT_CAP) {
    return { kind: 'saturated', fences: parsed.data };
  }
  return { kind: 'valid', fences: parsed.data };
}

/** Drop fences whose outer deadline already passed. Called on every native access. */
export function pruneRetirements(
  fences: readonly NativeRetirementFence[],
  now: number
): NativeRetirementFence[] {
  return fences.filter(fence => fence.until > now);
}

/** True when `launchId` is a retired nonce that must be rejected until its outer deadline. */
export function isRetired(
  fences: readonly NativeRetirementFence[],
  launchId: string,
  now: number
): boolean {
  return fences.some(fence => fence.launchId === launchId && fence.until > now);
}

export type RecordRetirementResult =
  | { kind: 'recorded'; fences: NativeRetirementFence[] }
  | { kind: 'exists'; fences: NativeRetirementFence[] }
  | { kind: 'expired'; fences: NativeRetirementFence[] }
  | { kind: 'saturated'; fences: NativeRetirementFence[] };

/**
 * Record a retired nonce, retaining it through the outer deadline. Prunes expiry
 * first. Refuses saturation recoverably rather than dropping a live fence, and
 * never shortens or replaces an existing fence.
 */
export function recordRetirement(
  fences: readonly NativeRetirementFence[],
  launchId: string,
  outerDeadlineAt: number,
  now: number
): RecordRetirementResult {
  if (!RUNTIME_LAUNCH_ID_PATTERN.test(launchId)) {
    throw new Error('invalid native retirement nonce');
  }
  const live = pruneRetirements(fences, now);
  const existing = live.find(fence => fence.launchId === launchId);
  // Never shorten or replace a live fence: an existing entry is kept unchanged.
  if (existing !== undefined) return { kind: 'exists', fences: live };
  if (outerDeadlineAt <= now) return { kind: 'expired', fences: live };
  if (live.length >= NATIVE_RETIREMENT_CAP) return { kind: 'saturated', fences: live };
  return { kind: 'recorded', fences: [...live, { launchId, until: outerDeadlineAt }] };
}

/**
 * Whether a Stop's captured token still matches the live launch identity. A
 * legacy tokenless Stop (no token) never matches a versioned launch, so it
 * cannot destroy a replacement.
 */
export function nativeLaunchTokenMatches(
  record: { launchId?: string; outerDeadlineAt?: number },
  token: NativeLaunchToken | undefined
): boolean {
  if (token === undefined) return record.launchId === undefined;
  return record.launchId === token.launchId && record.outerDeadlineAt === token.createDeadlineAt;
}

/** The effective attempt bound: min(outer deadline, firstReservation + source budget). */
export function nativeAttemptDeadlineAt(
  startSource: NativeLaunchSource['kind'],
  firstReservationAt: number,
  outerDeadlineAt: number
): number {
  const budget =
    startSource === 'repository' ? NATIVE_REPOSITORY_ATTEMPT_MS : NATIVE_IMAGE_ATTEMPT_MS;
  return Math.min(outerDeadlineAt, firstReservationAt + budget);
}

/**
 * The environment keys an artifact grant, descriptor or origin must never enter.
 * The grant travels in the supplied command text, never a persistent startup env.
 */
const NATIVE_ARTIFACT_ENV_KEYS = [
  RUNTIME_DESCRIPTOR_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_ARTIFACT_GRANT_ENV,
] as const;

/** Strip every artifact-delivery value from a native startup env. */
export function withoutArtifactEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  for (const key of NATIVE_ARTIFACT_ENV_KEYS) delete next[key];
  return next;
}

/** Labels attached to a native start so a later `inspect()` can corroborate it. */
export function nativeLaunchLabels(launchId: string): Record<string, string> {
  return { [NATIVE_LAUNCH_LABEL]: launchId };
}

/**
 * Classify PID 1 into the provider-neutral process observation. The exact
 * canonical supervisor is `supervisor`; a live unrecognised process is the
 * installer or the failure hold (`running`); the image default `sleep infinity`
 * proves our command is gone (`terminal`); an empty or unreadable cmdline is
 * `unknown`.
 */
export function nativeProcessObservation(cmdline: Uint8Array): RuntimeLaunchProcessObservation {
  const identity = classifyMainProcess(cmdline);
  if (identity === 'supervisor') return 'supervisor';
  if (identity === 'sleep') return 'terminal';
  // An empty cmdline is a NUL byte or nothing; anything longer is a live process.
  return cmdline.byteLength > 1 ? 'running' : 'unknown';
}

/** The exact receipt path a typed failure hold waits on; deleting it is the ACK. */
export function nativeReceiptPath(launchId: string): string {
  return runtimeLaunchReceiptPath(launchId);
}

/**
 * A shell prologue that rejects every symlink component of the receipt directory
 * chain (including `/opt` and `/opt/kilo-cloud`) and the final file, so a
 * restored link can never redirect a read or a deletion. Exit 3 is a hostile
 * path; each caller adds its own success/absence exits.
 */
function receiptShellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function receiptPathGuard(directory: string, path: string): string {
  if (!directory.startsWith('/')) throw new Error('Receipt directory must be absolute');
  const parts = directory.split('/').filter(Boolean);
  return [
    ...parts.map((_, index) => {
      const component = receiptShellWord('/' + parts.slice(0, index + 1).join('/'));
      return `if [ -L ${component} ] || [ ! -d ${component} ]; then exit 3; fi`;
    }),
    `if [ -L ${receiptShellWord(path)} ]; then exit 3; fi`,
  ].join('\n');
}

/**
 * A bounded, symlink-rejecting read of only this launch's receipt. Exit 0 carries
 * the bytes; exit 1 is a confirmed absence; any other exit (including a hostile
 * link component) is not proof.
 */
export function nativeReceiptReadCommand(
  launchId: string,
  reservedRoot = RUNTIME_RESERVED_ROOT
): string[] {
  const dir = runtimeLaunchReceiptDir(reservedRoot);
  const path = receiptShellWord(runtimeLaunchReceiptPath(launchId, reservedRoot));
  const max = RUNTIME_LAUNCH_RECEIPT_MAX_BYTES + 1;
  return [
    '/bin/sh',
    '-c',
    `${receiptPathGuard(dir, runtimeLaunchReceiptPath(launchId, reservedRoot))}\nif [ ! -f ${path} ]; then exit 1; fi\nhead -c ${max} -- ${path}`,
  ];
}

/**
 * A bounded, symlink-rejecting deletion of exactly this launch's receipt that
 * only removes it when its bytes still equal the expected observed receipt. Exit
 * 0 is a confirmed deletion; exit 1 is an absence; exit 2 is a byte mismatch; a
 * hostile path is exit 3. `expected` travels as `$1`, never interpolated.
 */
export function nativeReceiptDeleteCommand(
  launchId: string,
  expected: string,
  reservedRoot = RUNTIME_RESERVED_ROOT
): string[] {
  const dir = runtimeLaunchReceiptDir(reservedRoot);
  const path = runtimeLaunchReceiptPath(launchId, reservedRoot);
  const quoted = receiptShellWord(path);
  const script = [
    'expected="$1"',
    receiptPathGuard(dir, path),
    `if [ ! -f ${quoted} ]; then exit 1; fi`,
    `content=$(cat -- ${quoted}) || exit 1`,
    'if [ "$content" != "$expected" ]; then exit 2; fi',
    `rm -f -- ${quoted}`,
  ].join('\n');
  return ['/bin/sh', '-c', script, 'kilo-launch-ack', expected];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  );
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Bounded, non-secret operator evidence. Digests only; never a raw locator or secret. */
export type NativeLaunchEvidence = {
  doId: string;
  allocationId: string | null;
  launchId: string | null;
  startSource: NativeLaunchSource['kind'] | null;
  baseFingerprint: string | null;
  snapshotFingerprint: string | null;
  issuedAt: number | null;
  settled: NativeLaunchSettlement | null;
  runtimeIdentity: RuntimeLaunchIdentity | null;
  lastConfirmedStop: NativeStopEvidence | null;
};

export async function nativeLaunchEvidence(
  doId: string,
  record: NativeLaunchRecord | undefined,
  lastConfirmedStop?: unknown
): Promise<NativeLaunchEvidence> {
  const stopRead = nativeStopEvidenceSchema.safeParse(lastConfirmedStop);
  const stopEvidence = stopRead.success ? stopRead.data : null;
  if (record === undefined) {
    return {
      doId,
      allocationId: null,
      launchId: null,
      startSource: null,
      baseFingerprint: null,
      snapshotFingerprint: null,
      issuedAt: null,
      settled: null,
      runtimeIdentity: null,
      lastConfirmedStop: stopEvidence,
    };
  }
  return {
    doId,
    allocationId: record.allocationId,
    launchId: record.launchId,
    startSource: record.source.kind,
    baseFingerprint: await sha256Hex(record.source.image),
    snapshotFingerprint:
      record.source.kind === 'repository'
        ? await sha256Hex(`${record.source.indexKey}:${record.source.snapshotId}`)
        : null,
    issuedAt: record.issuedAt ?? null,
    settled: record.settled ?? null,
    runtimeIdentity: record.runtimeIdentity ?? null,
    lastConfirmedStop: stopEvidence,
  };
}

/** The reserve request the native Durable Object accepts. */
export type NativeInstanceSize = 'lite' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';

export type NativeReserveRequest = RuntimeReserveInput & {
  providerRef: string;
  instance: NativeInstanceSize;
  containment: boolean;
  egressAllowlist?: string[];
};

/** The start request the native Durable Object accepts. */
export type NativeStartRequest = RuntimeStartInput;

export type NativeObserveRequest = {
  providerRef: string;
  launchId: string;
  deadlineAt: number;
};

export type NativeSettleRequest = { launchId: string; result: RuntimeLaunchResult };

export type NativeAckRequest = { launchId: string; receipt?: string };

export type NativeDestroyRequest = {
  providerRef: string;
  launchId: string;
  outerDeadlineAt: number;
};

export type NativeRetireRequest = {
  providerRef: string;
  launchId: string;
  outerDeadlineAt: number;
};

/** A native observation plus the retired signal the common phase consumes. */
export type NativeLaunchObservation = RuntimeLaunchObservation;
