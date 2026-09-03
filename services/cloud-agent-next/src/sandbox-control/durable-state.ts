import { z } from 'zod';
import { classifySandboxId } from '../sandbox-id.js';
import {
  SandboxRuntimeMetadataSchema,
  type SandboxRuntimeMetadata,
} from '../shared/sandbox-status.js';
import type { DeadlineTable } from './deadlines.js';
import { DEADLINE_IDS, emptyDeadlines } from './deadlines.js';
import { initialPhysicalRecord, type PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';
import {
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from './session-credentials.js';
import { emptyTransitionLog, type TransitionRow } from './transition-log.js';

export const PHYSICAL_KEY = 'physical_record';
const ROUTES_KEY = 'session_routes';
const DEADLINES_KEY = 'deadlines';
const LOG_KEY = 'transition_log';
const CREDENTIAL_GRANTS_KEY = 'worktree_credential_grants';
const RUNTIME_METADATA_KEY = 'runtime_metadata';

type ControlStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
};

const timestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
const physicalRecordSchema = z.object({
  state: z.enum(['stopped', 'creating', 'running', 'stopping', 'failed', 'unknown']),
  providerRef: z.string().min(1).nullable(),
  createIntent: z.object({ intentId: z.string().min(1), createdAt: timestampSchema }).nullable(),
  stopTombstone: z
    .object({
      reason: z.string(),
      attempts: z.number().int().nonnegative(),
      createdAt: timestampSchema,
    })
    .nullable(),
  resumable: z.boolean(),
});
const deadlineTableSchema = z.partialRecord(z.enum(DEADLINE_IDS), timestampSchema);
const sessionRouteSchema = z.object({
  sessionId: z.string().min(1),
  kiloSessionId: z.string().min(1),
  directory: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
  ownerId: z.string().min(1),
  lastState: z.enum(['idle', 'active', 'finalizing']).nullable(),
  lastStateAt: timestampSchema.nullable(),
  idleForMs: z.number().int().nonnegative().nullable(),
  waitingOn: z.enum(['model', 'tool', 'finalizing', 'preparation', 'input']).nullable(),
});
const routeTableSchema = z.array(sessionRouteSchema);

export type StoredSandboxControlState = {
  physical: PhysicalRecord | null;
  deadlines: DeadlineTable | null;
  routes: SessionRoute[] | null;
  runtime?: SandboxRuntimeMetadata;
};

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

export async function readSandboxControlState(storage: {
  get(key: string): Promise<unknown>;
}): Promise<StoredSandboxControlState> {
  const [physical, deadlines, routes, runtime] = await Promise.all([
    storage.get(PHYSICAL_KEY),
    storage.get(DEADLINES_KEY),
    storage.get(ROUTES_KEY),
    loadRuntimeMetadata(storage),
  ]);
  const parsedPhysical = physicalRecordSchema.safeParse(physical);
  const parsedDeadlines = deadlineTableSchema.safeParse(deadlines);
  const parsedRoutes = routeTableSchema.safeParse(routes);
  return {
    physical: parsedPhysical.success ? parsedPhysical.data : null,
    deadlines: parsedDeadlines.success ? parsedDeadlines.data : null,
    routes: parsedRoutes.success ? parsedRoutes.data : null,
    ...(runtime ? { runtime } : {}),
  };
}

export async function loadPhysicalRecord(
  storage: ControlStorage,
  resumable = false
): Promise<PhysicalRecord> {
  const stored = await storage.get<PhysicalRecord>(PHYSICAL_KEY);
  return stored ?? initialPhysicalRecord(resumable);
}

export async function savePhysicalRecord(
  storage: ControlStorage,
  record: PhysicalRecord
): Promise<void> {
  await storage.put(PHYSICAL_KEY, record);
}

export async function loadRouteTable(storage: ControlStorage): Promise<Map<string, SessionRoute>> {
  const rows = (await storage.get<SessionRoute[]>(ROUTES_KEY)) ?? [];
  return new Map(rows.map(route => [route.sessionId, route]));
}

export async function saveRouteTable(
  storage: ControlStorage,
  table: Map<string, SessionRoute>
): Promise<void> {
  await storage.put(ROUTES_KEY, [...table.values()]);
}

export async function loadDeadlines(storage: ControlStorage): Promise<DeadlineTable> {
  return (await storage.get<DeadlineTable>(DEADLINES_KEY)) ?? emptyDeadlines();
}

export async function saveDeadlines(storage: ControlStorage, table: DeadlineTable): Promise<void> {
  await storage.put(DEADLINES_KEY, table);
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

export async function eraseSandboxRecord(storage: ControlStorage): Promise<void> {
  await storage.delete([
    PHYSICAL_KEY,
    ROUTES_KEY,
    DEADLINES_KEY,
    LOG_KEY,
    CREDENTIAL_GRANTS_KEY,
    RUNTIME_METADATA_KEY,
  ]);
}
