import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import {
  controlLogAllocationIdSchema,
  controlLogIdentitySchema,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';

export {
  WORKTREE_SNAPSHOT_MAX_BYTES,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from '../shared/worktree-snapshot.js';

export const WORKTREE_SNAPSHOT_AUDIENCE = 'cloud-agent-worktree-snapshot';
export const WORKTREE_SNAPSHOT_GRANT_SECONDS = 4 * 60 * 60;
export const WORKTREE_SNAPSHOT_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
export const WORKTREE_SNAPSHOT_TOMBSTONE_PREFIX = 'worktree_snapshot_tombstone/';

const grantSchema = z
  .object({
    type: z.literal('worktree_snapshot'),
    aud: z.literal(WORKTREE_SNAPSHOT_AUDIENCE),
    identity: controlLogIdentitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export const worktreeSnapshotAuthorizationInputSchema = z
  .object({
    allocationId: controlLogAllocationIdSchema,
    worktreeId: cloudAgentWorktreeIdSchema,
  })
  .strict();

export const worktreeSnapshotTombstoneInputSchema = z
  .object({ worktreeId: cloudAgentWorktreeIdSchema })
  .strict();

export type WorktreeSnapshotAuthorizationInput = z.infer<
  typeof worktreeSnapshotAuthorizationInputSchema
>;

export function worktreeSnapshotObjectKey(worktreeId: string): string {
  return `v1/${worktreeId}.tar.gz`;
}

export function worktreeSnapshotTombstoneKey(worktreeId: string): string {
  return `${WORKTREE_SNAPSHOT_TOMBSTONE_PREFIX}${worktreeId}`;
}

export function mintWorktreeSnapshotGrant(identity: ControlLogIdentity, secret: string): string {
  return jwt.sign(
    { type: 'worktree_snapshot', identity: controlLogIdentitySchema.parse(identity) },
    secret,
    {
      algorithm: 'HS256',
      audience: WORKTREE_SNAPSHOT_AUDIENCE,
      expiresIn: WORKTREE_SNAPSHOT_GRANT_SECONDS,
    }
  );
}

export function validateWorktreeSnapshotGrant(
  authorization: string | null,
  secret: string | null
): ControlLogIdentity | undefined {
  if (!secret || !authorization || authorization.length > 4096) return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(match[1], secret, {
        algorithms: ['HS256'],
        audience: WORKTREE_SNAPSHOT_AUDIENCE,
      })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, identity } = parsed.data;
    if (exp <= iat || exp - iat > WORKTREE_SNAPSHOT_GRANT_SECONDS || iat > Date.now() / 1000 + 30) {
      return undefined;
    }
    return identity;
  } catch {
    return undefined;
  }
}

export function worktreeSnapshotWritesEnabled(env: {
  WORKTREE_SNAPSHOT_WRITES_ENABLED?: string;
}): boolean {
  return env.WORKTREE_SNAPSHOT_WRITES_ENABLED === 'true';
}

export function worktreeSnapshotReadsEnabled(env: {
  WORKTREE_SNAPSHOT_WRITES_ENABLED?: string;
  WORKTREE_SNAPSHOT_READS_ENABLED?: string;
}): boolean {
  return worktreeSnapshotWritesEnabled(env) && env.WORKTREE_SNAPSHOT_READS_ENABLED === 'true';
}

export function decideWorktreeSnapshotAuthorization(input: {
  allocationId: string;
  currentAllocationId: string | null;
  allocationKind: string;
  routeScopeIds: readonly string[];
  worktreeId: string;
  tombstoned: boolean;
}): boolean {
  if (input.tombstoned) return false;
  if (input.currentAllocationId !== input.allocationId) return false;
  if (input.allocationKind === 'stopped' || input.allocationKind === 'stopping') return false;
  return input.routeScopeIds.some(scopeId => scopeId === input.worktreeId);
}

type SnapshotTombstoneStorage = {
  put(key: string, value: unknown): Promise<void>;
};

type SnapshotObjectBucket = {
  delete(key: string): Promise<void>;
};

/**
 * Writes the tombstone first, so a failed object delete still refuses later
 * reads and uploads. Returns false only when the object delete failed; the
 * 30-day lifecycle remains the fallback for that object.
 */
export async function purgeWorktreeSnapshot(input: {
  worktreeId: string;
  storage: SnapshotTombstoneStorage;
  bucket?: SnapshotObjectBucket;
}): Promise<boolean> {
  await input.storage.put(worktreeSnapshotTombstoneKey(input.worktreeId), Date.now());
  if (!input.bucket) return true;
  try {
    await input.bucket.delete(worktreeSnapshotObjectKey(input.worktreeId));
    return true;
  } catch {
    return false;
  }
}
