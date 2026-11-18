import { z } from 'zod';
import type { ByocVercelOwner } from './vercel-owner.js';

export type SnapshotBuildOwner =
  | { type: 'org'; organizationId: string }
  | { type: 'user'; userId: string };

export function ownerToRowKey(owner: SnapshotBuildOwner): string {
  return owner.type === 'org' ? owner.organizationId : `user:${owner.userId}`;
}

export function ownerFromRow(row: {
  organization_id: string;
  owner_type: string;
}): SnapshotBuildOwner {
  const ownerType = z.enum(['org', 'user']).parse(row.owner_type);
  if (ownerType === 'org') {
    if (row.organization_id.startsWith('user:')) {
      throw new Error('snapshot_owner_row_key_mismatch');
    }
    return { type: 'org', organizationId: row.organization_id };
  }
  if (!row.organization_id.startsWith('user:') || row.organization_id.length <= 'user:'.length) {
    throw new Error('snapshot_owner_row_key_mismatch');
  }
  return { type: 'user', userId: row.organization_id.slice('user:'.length) };
}

export function ownerToProjection(
  owner: SnapshotBuildOwner
): { organizationId: string } | { userId: string } {
  return owner.type === 'org' ? { organizationId: owner.organizationId } : { userId: owner.userId };
}

export function ownerFromInput(input: ByocVercelOwner): SnapshotBuildOwner {
  return input.organizationId !== undefined
    ? { type: 'org', organizationId: input.organizationId }
    : { type: 'user', userId: input.userId };
}

export function ownerCredentialFetchInput(
  owner: SnapshotBuildOwner,
  credentialId: string
): { organizationId: string; credentialId: string } | { userId: string; credentialId: string } {
  return owner.type === 'org'
    ? { organizationId: owner.organizationId, credentialId }
    : { userId: owner.userId, credentialId };
}
