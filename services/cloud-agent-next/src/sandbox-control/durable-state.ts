import { z } from 'zod';
import { classifySandboxId } from '../sandbox-id.js';
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_ENTRIES,
  emptySessionReferenceState,
  serializedReferenceBytes,
  type SessionReferenceState,
} from './session-references.js';
import {
  SandboxRuntimeMetadataSchema,
  type SandboxRuntimeMetadata,
} from '../shared/sandbox-status.js';
import type { SessionRoute } from './session-routes.js';
import {
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from './session-credentials.js';
import { emptyTransitionLog, type TransitionRow } from './transition-log.js';
import { CONTROL_ALARM_ANCHORS_KEY, LEGACY_CONTROL_DEADLINES_KEY } from './control-alarm.js';
import { eraseAllocationRecord } from '../sandbox-state/persist/access.js';
import type { SyncRecordReader, SyncRecordWriter } from '../sandbox-state/persist/access.js';
import {
  loadAllocation as loadCanonicalAllocation,
  loadAllocationSync as loadCanonicalAllocationSync,
} from '../sandbox-state/persist/load.js';
import { storeAllocation as storeCanonicalAllocation } from '../sandbox-state/persist/store.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';

const ROUTES_KEY = 'session_routes';
export const SESSION_REFERENCES_KEY = 'session_references';
const LOG_KEY = 'transition_log';
const CREDENTIAL_GRANTS_KEY = 'worktree_credential_grants';
const RUNTIME_METADATA_KEY = 'runtime_metadata';

type ControlStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
};

const sessionReferenceSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    kiloSessionId: z.string().min(1).max(128),
    directory: z.string().min(1).max(512),
    worktreeId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const sessionReferenceStateSchema = z.object({
  reconciled: z.boolean(),
  overflowed: z.boolean(),
  entries: z
    .array(sessionReferenceSchema)
    .max(MAX_REFERENCE_ENTRIES)
    .refine(entries => serializedReferenceBytes(entries) <= MAX_REFERENCE_BYTES),
});

export function initialRuntimeMetadata(sandboxId: string): SandboxRuntimeMetadata {
  const classification = classifySandboxId(sandboxId);
  return {
    sandboxType: classification === 'legacy-shared' ? 'shared' : classification,
    kiloCliVersion: null,
    wrapperVersion: null,
    startedAt: null,
    stoppedAt: null,
  };
}

export async function loadRuntimeMetadata(storage: {
  get(key: string): Promise<unknown>;
}): Promise<SandboxRuntimeMetadata | undefined> {
  const parsed = SandboxRuntimeMetadataSchema.safeParse(await storage.get(RUNTIME_METADATA_KEY));
  return parsed.success ? parsed.data : undefined;
}

export async function saveRuntimeMetadata(
  storage: ControlStorage,
  runtime: SandboxRuntimeMetadata
): Promise<void> {
  await storage.put(RUNTIME_METADATA_KEY, SandboxRuntimeMetadataSchema.parse(runtime));
}

/** Synchronous twin of `saveRuntimeMetadata` for use inside `transactionSync`. */
export function saveRuntimeMetadataSync(
  storage: SyncRecordWriter,
  runtime: SandboxRuntimeMetadata
): void {
  storage.put(RUNTIME_METADATA_KEY, SandboxRuntimeMetadataSchema.parse(runtime));
}

/**
 * Canonical allocation aggregate under `sandbox_allocation_state`. The live path
 * reads and writes only this; a fail-closed load is surfaced as a thrown error,
 * never a silent fallback to the removed flat record.
 */
export async function loadAllocation(
  storage: ControlStorage,
  resumable = false
): Promise<AllocationRecord> {
  const result = await loadCanonicalAllocation(storage, resumable);
  if (!result.ok) throw new Error(`Invalid canonical allocation: ${result.reason}`);
  return result.value;
}

export function loadAllocationSync(storage: SyncRecordReader, resumable = false): AllocationRecord {
  const result = loadCanonicalAllocationSync(storage, resumable);
  if (!result.ok) throw new Error(`Invalid canonical allocation: ${result.reason}`);
  return result.value;
}

export async function storeAllocation(
  storage: ControlStorage,
  record: AllocationRecord
): Promise<void> {
  await storeCanonicalAllocation(storage, record);
}

export async function loadRouteTable(storage: ControlStorage): Promise<Map<string, SessionRoute>> {
  const rows = (await storage.get<SessionRoute[]>(ROUTES_KEY)) ?? [];
  return new Map(rows.map(route => [route.sessionId, route]));
}

export function loadRouteTableSync(storage: {
  get<T = unknown>(key: string): T | undefined;
}): Map<string, SessionRoute> {
  const rows = storage.get<SessionRoute[]>(ROUTES_KEY) ?? [];
  return new Map(rows.map(route => [route.sessionId, route]));
}

export async function saveRouteTable(
  storage: ControlStorage,
  table: Map<string, SessionRoute>
): Promise<void> {
  await storage.put(ROUTES_KEY, [...table.values()]);
}

export async function loadSessionReferences(
  storage: ControlStorage
): Promise<SessionReferenceState> {
  const stored = await storage.get(SESSION_REFERENCES_KEY);
  if (stored === undefined) return emptySessionReferenceState();
  const parsed = sessionReferenceStateSchema.safeParse(stored);
  if (!parsed.success) throw new Error('Invalid stored session references');
  return parsed.data;
}

export async function saveSessionReferences(
  storage: ControlStorage,
  state: SessionReferenceState
): Promise<void> {
  await storage.put(SESSION_REFERENCES_KEY, sessionReferenceStateSchema.parse(state));
}

export async function loadTransitionLog(storage: ControlStorage): Promise<TransitionRow[]> {
  return (await storage.get<TransitionRow[]>(LOG_KEY)) ?? emptyTransitionLog();
}

export async function saveTransitionLog(
  storage: ControlStorage,
  log: TransitionRow[]
): Promise<void> {
  await storage.put(LOG_KEY, log);
}

export async function loadSessionCredentialGrants(
  storage: ControlStorage
): Promise<SessionCredentialGrant[]> {
  const stored = await storage.get(CREDENTIAL_GRANTS_KEY);
  const parsed = sessionCredentialGrantSchema.array().safeParse(stored ?? []);
  if (!parsed.success) throw new Error('Invalid stored worktree credentials');
  return parsed.data;
}

export async function saveSessionCredentialGrants(
  storage: ControlStorage,
  grants: SessionCredentialGrant[]
): Promise<void> {
  await storage.put(CREDENTIAL_GRANTS_KEY, grants);
}

/** Synchronous twin of `saveSessionCredentialGrants` for use inside `transactionSync`. */
export function saveSessionCredentialGrantsSync(
  storage: SyncRecordWriter,
  grants: SessionCredentialGrant[]
): void {
  storage.put(CREDENTIAL_GRANTS_KEY, grants);
}

export async function eraseSandboxRecord(storage: ControlStorage): Promise<void> {
  await eraseAllocationRecord(storage, [
    ROUTES_KEY,
    SESSION_REFERENCES_KEY,
    LOG_KEY,
    CREDENTIAL_GRANTS_KEY,
    RUNTIME_METADATA_KEY,
    CONTROL_ALARM_ANCHORS_KEY,
    LEGACY_CONTROL_DEADLINES_KEY,
  ]);
}
