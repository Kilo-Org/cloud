import type { DirectoryBackup } from '@cloudflare/sandbox';
import * as z from 'zod';

import { WRAPPER_VERSION } from './shared/wrapper-version.js';

const CACHE_SCHEMA = 'workspace-backup-v1';
const CACHE_OBJECT_PREFIX = 'workspace-backups/v1';

export const WORKSPACE_BACKUP_TTL_MS = 24 * 60 * 60 * 1000;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const directoryBackupSchema = z
  .object({
    id: z.string().min(1),
    dir: z.string().min(1),
    localBucket: z.boolean().optional(),
  })
  .strip();

const workspaceBackupOwnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization'), organizationId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('user'), userId: z.string().min(1) }).strict(),
]);

const workspaceBackupRecordSchema = z
  .object({
    schema: z.literal(CACHE_SCHEMA),
    digest: digestSchema,
    owner: workspaceBackupOwnerSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/i),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    backup: directoryBackupSchema,
  })
  .strip();

export type WorkspaceBackupRepository =
  | { type: 'github'; repo: string }
  | { type: 'git' | 'gitlab'; url: string };

export type WorkspaceBackupOwner =
  | { type: 'organization'; organizationId: string }
  | { type: 'user'; userId: string };

export type WorkspaceBackupCandidateRequest = {
  fresh: boolean;
  devcontainer: boolean;
  setupCommands?: string[];
  setupEnvironment: {
    variables: Record<string, string>;
    secretIdentities: Record<string, string>;
  };
  userId: string;
  orgId?: string;
  repository?: WorkspaceBackupRepository;
  shallow?: boolean;
};

export type WorkspaceBackupCandidate = {
  digest: string;
  objectKey: string;
  owner: WorkspaceBackupOwner;
  canonicalRepository: string;
};

export type WorkspaceBackupRecord = z.infer<typeof workspaceBackupRecordSchema>;

type WorkspaceBackupKey = {
  schema: typeof CACHE_SCHEMA;
  wrapperVersion: string;
  owner: WorkspaceBackupOwner;
  repository: string;
  shallow: boolean;
  setupCommands: string[];
  setupEnvironment: {
    variables: Record<string, string>;
    secretIdentities: Record<string, string>;
  };
};

function canonicalizeRepository(repository: WorkspaceBackupRepository | undefined): string | null {
  if (!repository) return null;

  if (repository.type === 'github') {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository.repo)) return null;
    return `https://github.com/${repository.repo}.git`;
  }

  try {
    const url = new URL(repository.url);
    if (url.protocol !== 'https:' || !url.hostname || url.hash || url.search) return null;

    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.pathname === '') return null;

    return url.toString();
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string | null {
  const ancestors = new WeakSet<object>();

  function serialize(current: unknown): string | null {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) ? JSON.stringify(current) : null;
    }
    if (typeof current !== 'object') return null;
    if (ancestors.has(current)) return null;

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) return null;
          const serialized = serialize(current[index]);
          if (serialized === null) return null;
          values.push(serialized);
        }
        return `[${values.join(',')}]`;
      }

      if (Object.prototype.toString.call(current) !== '[object Object]') return null;

      const entries: string[] = [];
      const sortedEntries = Object.entries(current).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      );
      for (const [key, nestedValue] of sortedEntries) {
        if (nestedValue === undefined) continue;
        const serialized = serialize(nestedValue);
        if (serialized === null) return null;
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  try {
    return serialize(value);
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function ownersEqual(left: WorkspaceBackupOwner, right: WorkspaceBackupOwner): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'organization' && right.type === 'organization') {
    return left.organizationId === right.organizationId;
  }
  if (left.type === 'user' && right.type === 'user') return left.userId === right.userId;
  return false;
}

export async function buildWorkspaceBackupCandidate(
  request: WorkspaceBackupCandidateRequest
): Promise<WorkspaceBackupCandidate | null> {
  if (
    !request.fresh ||
    request.devcontainer ||
    request.userId.length === 0 ||
    request.orgId === '' ||
    !request.setupCommands?.length
  )
    return null;

  const canonicalRepository = canonicalizeRepository(request.repository);
  if (!canonicalRepository) return null;

  const owner: WorkspaceBackupOwner = request.orgId
    ? { type: 'organization', organizationId: request.orgId }
    : { type: 'user', userId: request.userId };
  const key = {
    schema: CACHE_SCHEMA,
    wrapperVersion: WRAPPER_VERSION,
    owner,
    repository: canonicalRepository,
    shallow: request.shallow ?? false,
    setupCommands: request.setupCommands ?? [],
    setupEnvironment: request.setupEnvironment,
  } satisfies WorkspaceBackupKey;
  const canonicalKey = canonicalJson(key);
  if (canonicalKey === null) return null;

  const digest = await sha256(canonicalKey);
  return {
    digest,
    objectKey: `${CACHE_OBJECT_PREFIX}/${digest}.json`,
    owner,
    canonicalRepository,
  };
}

export async function loadWorkspaceBackupRecord(
  bucket: R2Bucket,
  candidate: WorkspaceBackupCandidate,
  now = Date.now()
): Promise<WorkspaceBackupRecord | null> {
  try {
    const object = await bucket.get(candidate.objectKey);
    if (!object) return null;

    const parsed = workspaceBackupRecordSchema.safeParse(await object.json());
    if (!parsed.success) return null;
    if (parsed.data.digest !== candidate.digest) return null;
    if (!ownersEqual(parsed.data.owner, candidate.owner)) return null;
    if (parsed.data.createdAt > now) return null;
    if (parsed.data.expiresAt <= parsed.data.createdAt) return null;
    if (parsed.data.expiresAt - parsed.data.createdAt > WORKSPACE_BACKUP_TTL_MS) return null;
    if (parsed.data.expiresAt <= now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function createWorkspaceBackupRecord(
  candidate: WorkspaceBackupCandidate,
  backup: DirectoryBackup,
  sourceCommit: string,
  now = Date.now()
): WorkspaceBackupRecord {
  return workspaceBackupRecordSchema.parse({
    schema: CACHE_SCHEMA,
    digest: candidate.digest,
    owner: candidate.owner,
    sourceCommit,
    createdAt: now,
    expiresAt: now + WORKSPACE_BACKUP_TTL_MS,
    backup,
  });
}

export async function storeWorkspaceBackupRecord(
  bucket: R2Bucket,
  candidate: WorkspaceBackupCandidate,
  record: WorkspaceBackupRecord
): Promise<void> {
  const validated = workspaceBackupRecordSchema.parse(record);
  if (validated.digest !== candidate.digest || !ownersEqual(validated.owner, candidate.owner)) {
    throw new Error('Workspace backup record does not match its cache candidate');
  }

  await bucket.put(candidate.objectKey, JSON.stringify(validated), {
    httpMetadata: { contentType: 'application/json' },
  });
}
