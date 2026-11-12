import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  workspaceRepositoryAccessSchema,
  repositoryAccessView,
  MAX_WORKSPACE_REPOSITORIES,
  type WorkspaceRepositoryAccess,
  type WorkspaceGitHubRepositoryAccess,
  type RepositoryAccessView,
} from '@kilocode/worker-utils/workspace-repository-access';
import { workspaceRepositoryAccess } from './sqlite-schema.js';

type AccessDatabase = Pick<ReturnType<typeof drizzle>, 'select' | 'insert' | 'delete'>;
export function readRepositoryAccess(
  db: AccessDatabase,
  scopeId: string
): WorkspaceRepositoryAccess | null {
  const row = db
    .select()
    .from(workspaceRepositoryAccess)
    .where(eq(workspaceRepositoryAccess.scope_id, scopeId))
    .get();
  if (!row) return null;
  // Invalid persisted policy is an availability failure. Never reseed a corrupt record.
  const access = workspaceRepositoryAccessSchema.safeParse(row.data);
  if (!access.success || access.data.scopeId !== scopeId)
    throw new Error('Repository authorization unavailable');
  return access.data;
}
export function writeRepositoryAccess(db: AccessDatabase, input: WorkspaceRepositoryAccess): void {
  const access = workspaceRepositoryAccessSchema.parse(input);
  const row = { scope_id: access.scopeId, data: access };
  db.insert(workspaceRepositoryAccess)
    .values(row)
    .onConflictDoUpdate({ target: workspaceRepositoryAccess.scope_id, set: row })
    .run();
}
export function deleteRepositoryAccess(db: AccessDatabase, scopeId: string): void {
  db.delete(workspaceRepositoryAccess).where(eq(workspaceRepositoryAccess.scope_id, scopeId)).run();
}
export type RepositoryAccessUpdate =
  | { changed: true; access: WorkspaceRepositoryAccess }
  | { changed: false; current: RepositoryAccessView };
/** Call inside the Sandbox DO queue after external credential preparation. */
export function changeRepositoryAccess(
  db: AccessDatabase,
  scopeId: string,
  expectedRevision: number,
  repositoryId: number,
  candidate: WorkspaceGitHubRepositoryAccess | null
): RepositoryAccessUpdate {
  const current = readRepositoryAccess(db, scopeId);
  if (!current) throw new Error('Repository authorization unavailable');
  if (current.revision !== expectedRevision)
    return { changed: false, current: repositoryAccessView(current) };
  const repositories = current.repositories.filter(repo => repo.repositoryId !== repositoryId);
  if (candidate) {
    if (
      !current.repositories.some(repo => repo.repositoryId === repositoryId) &&
      current.repositories.length >= MAX_WORKSPACE_REPOSITORIES
    )
      throw new Error('repository_limit_reached');
    if (candidate.repositoryId !== repositoryId) throw new Error('Repository identity mismatch');
    repositories.push(candidate);
  }
  const access = workspaceRepositoryAccessSchema.parse({
    ...current,
    revision: current.revision + 1,
    repositories,
  });
  writeRepositoryAccess(db, access);
  return { changed: true, access };
}
