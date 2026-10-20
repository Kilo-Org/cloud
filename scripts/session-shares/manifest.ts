import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShareBlobFilename, type ShareBlobFilename } from './blob-filenames';

export const CLEANUP_TARGETS = ['v2-webhook-bot', 'v1-publisher-mismatch', 'all'] as const;

export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export type CleanupItemState = 'pending' | 'revoking' | 'row_deleted' | 'done' | 'changed';

export type V2CleanupItem = {
  kind: 'v2';
  session_id: string;
  kilo_user_id: string;
  public_id: string;
  state: CleanupItemState;
  attempts: number;
  last_error: string | null;
};

export type V1CleanupItem = {
  kind: 'v1';
  share_id: string;
  session_id: string;
  publisher_kilo_user_id: string;
  source_owner_kilo_user_id: string;
  blob_filenames: ShareBlobFilename[];
  unsafe_blob_filenames: ShareBlobFilename[];
  state: CleanupItemState;
  attempts: number;
  last_error: string | null;
};

export type CleanupItem = V2CleanupItem | V1CleanupItem;

export type DiscoveryCursor = {
  v2: { kilo_user_id: string; session_id: string } | null;
  v1: { share_id: string } | null;
};

export type CleanupManifest = {
  version: 1;
  target: CleanupTarget;
  database_identity_hash: string;
  created_at: string;
  updated_at: string;
  discovery_complete: boolean;
  discovery: DiscoveryCursor;
  items: CleanupItem[];
};

export type ManifestStore = {
  load(): Promise<CleanupManifest | null>;
  save(manifest: CleanupManifest): Promise<void>;
};

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function databaseIdentityHash(connectionString: string): string {
  const url = new URL(connectionString);
  const identity = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  return createHash('sha256').update(identity).digest('hex');
}

export function createManifest(params: {
  target: CleanupTarget;
  databaseIdentityHash: string;
  now?: string;
}): CleanupManifest {
  const now = params.now ?? new Date().toISOString();
  return {
    version: 1,
    target: params.target,
    database_identity_hash: params.databaseIdentityHash,
    created_at: now,
    updated_at: now,
    discovery_complete: false,
    discovery: { v2: null, v1: null },
    items: [],
  };
}

function repositoryRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function resolveExistingPath(target: string): string {
  let current = path.resolve(target);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const resolved = realpathSync(current);
      return missingSegments.length > 0 ? path.join(resolved, ...missingSegments) : resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isInsideRepository(manifestPath: string): boolean {
  const root = resolveExistingPath(repositoryRoot());
  return (
    isPathInside(root, path.resolve(manifestPath)) ||
    isPathInside(root, resolveExistingPath(manifestPath))
  );
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new ManifestError('Manifest parent path is not a directory');
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    throw new ManifestError('Manifest directory must not be accessible by group or other users');
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await assertPrivateDirectory(directory);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTarget(value: unknown): value is CleanupTarget {
  return typeof value === 'string' && (CLEANUP_TARGETS as readonly string[]).includes(value);
}

function isItemState(value: unknown): value is CleanupItemState {
  return (
    value === 'pending' ||
    value === 'revoking' ||
    value === 'row_deleted' ||
    value === 'done' ||
    value === 'changed'
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function blobFilenameArray(value: unknown): value is ShareBlobFilename[] {
  return stringArray(value) && value.every(isShareBlobFilename);
}

function parseItem(value: unknown): CleanupItem {
  if (!isRecord(value) || !isItemState(value.state)) {
    throw new ManifestError('Manifest contains an invalid item');
  }
  if (typeof value.attempts !== 'number' || !Number.isInteger(value.attempts)) {
    throw new ManifestError('Manifest contains an invalid item attempt count');
  }
  if (typeof value.last_error !== 'string' && value.last_error !== null) {
    throw new ManifestError('Manifest contains an invalid item error');
  }

  if (value.kind === 'v2') {
    if (
      typeof value.session_id !== 'string' ||
      typeof value.kilo_user_id !== 'string' ||
      typeof value.public_id !== 'string'
    ) {
      throw new ManifestError('Manifest contains an invalid v2 item');
    }
    return {
      kind: 'v2',
      session_id: value.session_id,
      kilo_user_id: value.kilo_user_id,
      public_id: value.public_id,
      state: value.state,
      attempts: value.attempts,
      last_error: value.last_error,
    };
  }

  if (value.kind === 'v1') {
    if (
      typeof value.share_id !== 'string' ||
      typeof value.session_id !== 'string' ||
      typeof value.publisher_kilo_user_id !== 'string' ||
      typeof value.source_owner_kilo_user_id !== 'string' ||
      !blobFilenameArray(value.blob_filenames) ||
      !blobFilenameArray(value.unsafe_blob_filenames)
    ) {
      throw new ManifestError('Manifest contains an invalid v1 item');
    }
    return {
      kind: 'v1',
      share_id: value.share_id,
      session_id: value.session_id,
      publisher_kilo_user_id: value.publisher_kilo_user_id,
      source_owner_kilo_user_id: value.source_owner_kilo_user_id,
      blob_filenames: value.blob_filenames,
      unsafe_blob_filenames: value.unsafe_blob_filenames,
      state: value.state,
      attempts: value.attempts,
      last_error: value.last_error,
    };
  }

  throw new ManifestError('Manifest contains an unknown item kind');
}

export function parseManifest(raw: string): CleanupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestError('Manifest is not valid JSON');
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !isTarget(parsed.target)) {
    throw new ManifestError('Manifest header is invalid');
  }
  if (
    typeof parsed.database_identity_hash !== 'string' ||
    typeof parsed.created_at !== 'string' ||
    typeof parsed.updated_at !== 'string' ||
    typeof parsed.discovery_complete !== 'boolean' ||
    !isRecord(parsed.discovery) ||
    !Array.isArray(parsed.items)
  ) {
    throw new ManifestError('Manifest metadata is invalid');
  }

  const v2Cursor = parsed.discovery.v2;
  const v1Cursor = parsed.discovery.v1;
  let v2: DiscoveryCursor['v2'] = null;
  if (v2Cursor !== null) {
    if (
      !isRecord(v2Cursor) ||
      typeof v2Cursor.kilo_user_id !== 'string' ||
      typeof v2Cursor.session_id !== 'string'
    ) {
      throw new ManifestError('Manifest v2 cursor is invalid');
    }
    v2 = { kilo_user_id: v2Cursor.kilo_user_id, session_id: v2Cursor.session_id };
  }
  let v1: DiscoveryCursor['v1'] = null;
  if (v1Cursor !== null) {
    if (!isRecord(v1Cursor) || typeof v1Cursor.share_id !== 'string') {
      throw new ManifestError('Manifest v1 cursor is invalid');
    }
    v1 = { share_id: v1Cursor.share_id };
  }

  return {
    version: 1,
    target: parsed.target,
    database_identity_hash: parsed.database_identity_hash,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
    discovery_complete: parsed.discovery_complete,
    discovery: { v2, v1 },
    items: parsed.items.map(parseItem),
  };
}

export function createFileManifestStore(manifestPath: string): ManifestStore {
  const resolvedPath = path.resolve(manifestPath);
  if (isInsideRepository(resolvedPath)) {
    throw new ManifestError('Manifest must be stored outside the repository');
  }

  return {
    async load() {
      let manifestStat;
      try {
        manifestStat = await stat(resolvedPath);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          return null;
        }
        throw error;
      }
      if ((manifestStat.mode & 0o077) !== 0) {
        throw new ManifestError('Manifest must not be accessible by group or other users');
      }
      const raw = await readFile(resolvedPath, 'utf8');
      return parseManifest(raw);
    },

    async save(manifest) {
      const directory = path.dirname(resolvedPath);
      await ensurePrivateDirectory(directory);

      const temporaryPath = path.join(
        directory,
        `.${path.basename(resolvedPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
      );
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(temporaryPath, resolvedPath);
      await chmod(resolvedPath, 0o600);
    },
  };
}

export function createMemoryManifestStore(
  initial: CleanupManifest | null = null
): ManifestStore & { current(): CleanupManifest | null } {
  let serialized = initial === null ? null : JSON.stringify(initial);
  return {
    current: () => (serialized === null ? null : parseManifest(serialized)),
    async load() {
      return serialized === null ? null : parseManifest(serialized);
    },
    async save(next) {
      serialized = JSON.stringify(next);
    },
  };
}
