import { z } from 'zod';
import type { Env } from '../types.js';
import type {
  ControlPlaneCredentialSource,
  ControlPlaneEvent,
} from '../shared/control-plane-protocol.js';
import { isRecord, kiloEventSessionId } from '../shared/kilo-event.js';
import { SNAPSHOT_CAPTURE_TIMEOUT_MS } from '../sandbox-containers/native-capture.js';

export const SESSION_SNAPSHOT_KEY = 'session_disk_snapshot:v1';
export const SESSION_SNAPSHOT_CAPTURE_MS = 30_000;
export const SESSION_SNAPSHOT_READ_MS = 2_000;
export const SESSION_SNAPSHOT_LOOKUP_MS = 2_000;
export const SESSION_SNAPSHOT_RECONCILE_MS = 10_000;
export const SESSION_SNAPSHOT_RPC_MARGIN_MS = 1_000;
export const SESSION_SNAPSHOT_OPERATION_MS = SNAPSHOT_CAPTURE_TIMEOUT_MS + 5_000;
export const SESSION_SNAPSHOT_IDLE_WAIT_MS = SNAPSHOT_CAPTURE_TIMEOUT_MS + 30_000;
export const SESSION_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

const identifier = z.string().min(1).max(256);
export const sessionSnapshotIdentitySchema = z
  .object({
    sessionId: identifier,
    kiloSessionId: identifier,
    sandboxId: identifier,
    userId: identifier,
    orgId: identifier.optional(),
  })
  .strict();
export type SessionSnapshotIdentity = z.infer<typeof sessionSnapshotIdentitySchema>;

export const sessionSnapshotDescriptorSchema = sessionSnapshotIdentitySchema
  .extend({
    captureId: z.uuid(),
    lastMessageId: identifier,
    attemptId: identifier,
    sourceAllocationId: identifier,
    snapshotId: identifier,
    baseImage: z.string().min(1).max(2048),
    runtimeIdentity: z.string().min(1).max(16_384),
    capturedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type SessionSnapshotDescriptor = z.infer<typeof sessionSnapshotDescriptorSchema>;

export const sessionSnapshotCaptureInputSchema = sessionSnapshotIdentitySchema
  .extend({
    captureId: z.uuid(),
    lastMessageId: identifier,
    attemptId: identifier,
    reconcile: z.literal(true).optional(),
  })
  .strict();
export type SessionSnapshotCaptureInput = z.infer<typeof sessionSnapshotCaptureInputSchema>;
export const sessionSnapshotCaptureResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('deferred') }).strict(),
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('stored'), descriptor: sessionSnapshotDescriptorSchema }).strict(),
]);
export type SessionSnapshotCaptureResult = z.infer<typeof sessionSnapshotCaptureResultSchema>;
export const sessionSnapshotActivitySchema = z
  .object({
    allocationId: identifier,
    attemptId: identifier,
    active: z.boolean(),
  })
  .strict();
export type SessionSnapshotActivity = z.infer<typeof sessionSnapshotActivitySchema>;

export function isSessionSnapshotExecutionEvent(event: ControlPlaneEvent): boolean {
  const properties = event.properties;
  if (!kiloEventSessionId(properties)) return false;
  if (event.type === 'session.turn.open') return true;
  if (event.type === 'session.status' && isRecord(properties.status)) {
    return properties.status.type === 'busy' || properties.status.type === 'retry';
  }
  if (event.type === 'message.part.delta') {
    return (
      typeof properties.messageID === 'string' &&
      typeof properties.delta === 'string' &&
      properties.delta.length > 0 &&
      (properties.field === 'text' || properties.field === undefined)
    );
  }
  if (event.type === 'message.part.updated' && isRecord(properties.part)) {
    const part = properties.part;
    return (
      part.type === 'tool' &&
      typeof part.id === 'string' &&
      typeof part.messageID === 'string' &&
      isRecord(part.state) &&
      (part.state.status === 'running' || part.state.status === 'pending')
    );
  }
  return (
    (event.type === 'question.asked' || event.type === 'permission.asked') &&
    typeof properties.id === 'string'
  );
}

const pendingSchema = z
  .object({
    state: z.literal('pending'),
    input: sessionSnapshotCaptureInputSchema,
    reconcileAt: z.number().int().nonnegative(),
    deadlineAt: z.number().int().nonnegative(),
    idleDeadlineAt: z.number().int().nonnegative(),
  })
  .strict();
const readySchema = z
  .object({
    state: z.literal('ready'),
    descriptor: sessionSnapshotDescriptorSchema,
  })
  .strict();
const waitingSchema = z
  .object({
    state: z.literal('waiting'),
    input: sessionSnapshotCaptureInputSchema,
    deadlineAt: z.number().int().nonnegative(),
  })
  .strict();
const snapshotStateSchema = z.discriminatedUnion('state', [
  waitingSchema,
  pendingSchema,
  readySchema,
]);

type SnapshotStorage = {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
};

export function sessionSnapshotsEnabled(
  env: Pick<Env, 'SESSION_SNAPSHOT_ORG_IDS' | 'SESSION_SNAPSHOT_USER_IDS'>,
  source: Pick<ControlPlaneCredentialSource, 'userId' | 'orgId'>
): boolean {
  const includes = (raw: string | undefined, id: string | undefined) =>
    id !== undefined &&
    id !== '*' &&
    (raw ?? '')
      .split(',')
      .map(value => value.trim())
      .includes(id);
  return (
    includes(env.SESSION_SNAPSHOT_ORG_IDS, source.orgId) ||
    includes(env.SESSION_SNAPSHOT_USER_IDS, source.userId)
  );
}

export function sameSessionSnapshotIdentity(
  left: SessionSnapshotIdentity,
  right: SessionSnapshotIdentity
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.kiloSessionId === right.kiloSessionId &&
    left.sandboxId === right.sandboxId &&
    left.userId === right.userId &&
    left.orgId === right.orgId
  );
}

export function sessionSnapshotIdentity(
  sandboxId: string,
  sessionId: string,
  kiloSessionId: string,
  source: Pick<ControlPlaneCredentialSource, 'userId' | 'orgId'>
): SessionSnapshotIdentity {
  return {
    sandboxId,
    sessionId,
    kiloSessionId,
    userId: source.userId,
    ...(source.orgId === undefined ? {} : { orgId: source.orgId }),
  };
}

export function readSessionSnapshot(storage: SnapshotStorage) {
  const parsed = snapshotStateSchema.safeParse(storage.get(SESSION_SNAPSHOT_KEY));
  return parsed.success ? parsed.data : undefined;
}

export function invalidateSessionSnapshot(storage: SnapshotStorage): void {
  storage.delete(SESSION_SNAPSHOT_KEY);
}

export function admitSessionSnapshotWork(storage: SnapshotStorage): void {
  const current = readSessionSnapshot(storage);
  if (current !== undefined && current.state !== 'ready') storage.delete(SESSION_SNAPSHOT_KEY);
}

export function waitForSessionSnapshotIdle(
  storage: SnapshotStorage,
  input: SessionSnapshotCaptureInput,
  deadlineAt = Date.now() + SESSION_SNAPSHOT_IDLE_WAIT_MS
): void {
  storage.put(SESSION_SNAPSHOT_KEY, { state: 'waiting', input, deadlineAt });
}

export function beginSessionSnapshot(
  storage: SnapshotStorage,
  input: SessionSnapshotCaptureInput,
  idleDeadlineAt = Date.now() + SESSION_SNAPSHOT_IDLE_WAIT_MS
): void {
  invalidateSessionSnapshot(storage);
  storage.put(SESSION_SNAPSHOT_KEY, {
    state: 'pending',
    input,
    reconcileAt: Date.now() + SESSION_SNAPSHOT_CAPTURE_MS + SESSION_SNAPSHOT_READ_MS,
    deadlineAt: Date.now() + SESSION_SNAPSHOT_OPERATION_MS,
    idleDeadlineAt,
  });
}

export function publishSessionSnapshot(
  storage: SnapshotStorage,
  descriptor: SessionSnapshotDescriptor
): boolean {
  const current = readSessionSnapshot(storage);
  if (
    current?.state !== 'pending' ||
    current.input.captureId !== descriptor.captureId ||
    current.input.lastMessageId !== descriptor.lastMessageId ||
    current.input.attemptId !== descriptor.attemptId ||
    !sameSessionSnapshotIdentity(current.input, descriptor)
  )
    return false;
  storage.put(SESSION_SNAPSHOT_KEY, { state: 'ready', descriptor });
  return true;
}

export function readReadySessionSnapshot(
  storage: SnapshotStorage,
  identity: SessionSnapshotIdentity,
  now: number
): SessionSnapshotDescriptor | null {
  const current = readSessionSnapshot(storage);
  const parsed = sessionSnapshotDescriptorSchema.safeParse(
    current?.state === 'ready' ? current.descriptor : undefined
  );
  if (
    !parsed.success ||
    !sameSessionSnapshotIdentity(parsed.data, identity) ||
    parsed.data.capturedAt > now ||
    parsed.data.expiresAt <= now ||
    parsed.data.expiresAt > parsed.data.capturedAt + SESSION_SNAPSHOT_TTL_MS
  )
    return null;
  return parsed.data;
}
