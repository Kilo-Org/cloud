import type { DeadlineTable } from './deadlines.js';
import { emptyDeadlines } from './deadlines.js';
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

type ControlStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
};

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
  await storage.delete([PHYSICAL_KEY, ROUTES_KEY, DEADLINES_KEY, LOG_KEY, CREDENTIAL_GRANTS_KEY]);
}
