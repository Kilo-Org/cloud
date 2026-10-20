import { and, eq, gt, isNotNull, like, ne, or, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2, cliSessions, sharedCliSessions } from '@kilocode/db/schema';
import {
  createManifest,
  type CleanupItem,
  type CleanupManifest,
  type CleanupTarget,
  type ManifestStore,
  type V1CleanupItem,
  type V2CleanupItem,
} from './manifest';
import type { ShareBlobFilename } from './blob-filenames';

export { SHARE_BLOB_FILENAMES, type ShareBlobFilename } from './blob-filenames';

const WEBHOOK_BOT_PREFIX = 'bot-webhook-';
const BOT_PREFIX = 'bot-';

type ShareBlobColumn =
  | 'api_conversation_history_blob_url'
  | 'task_metadata_blob_url'
  | 'ui_messages_blob_url'
  | 'git_state_blob_url';

const SHARE_BLOB_COLUMNS: readonly {
  column: ShareBlobColumn;
  filename: ShareBlobFilename;
}[] = [
  {
    column: 'api_conversation_history_blob_url',
    filename: 'api_conversation_history',
  },
  { column: 'task_metadata_blob_url', filename: 'task_metadata' },
  { column: 'ui_messages_blob_url', filename: 'ui_messages' },
  { column: 'git_state_blob_url', filename: 'git_state' },
];

type ShareBlobRow = Record<ShareBlobColumn, string | null>;

export type BlobStore = {
  deleteShareBlobs(
    shareId: string,
    filenames: readonly ShareBlobFilename[],
    options?: { signal?: AbortSignal }
  ): Promise<void>;
};

export type CleanupMode = 'dry-run' | 'apply';

export type V2Summary = {
  webhook_bot_shared: number;
  webhook_bot_revoked: number;
  human_shared: number;
  other_bot_shared: number;
};

export type V1Summary = {
  total: number;
  owner_matched: number;
  publisher_mismatch: number;
  orphan: number;
  unmatched: number;
};

export type CleanupSummary = {
  v2?: V2Summary;
  v1?: V1Summary;
};

export type BatchEvent = {
  phase: 'discover' | 'apply';
  kind: 'v2' | 'v1';
  batch_index: number;
  size: number;
};

export type CleanupReport = {
  mode: CleanupMode;
  target: CleanupTarget;
  summary: CleanupSummary;
  manifest_written: boolean;
  manifest_candidates: { v2: number; v1: number } | null;
  apply: {
    completed: number;
    changed: number;
    remaining: number;
    pending_blob_deletes: number;
    failed: number;
    blobs_deleted: number;
    unsafe_blob_items: number;
    complete: boolean;
  } | null;
};

export type CleanupOptions = {
  db: DrizzleClient['db'];
  mode: CleanupMode;
  target: CleanupTarget;
  databaseIdentityHash: string;
  batchSize: number;
  maxAttempts: number;
  manifestStore: ManifestStore | null;
  blobStore: BlobStore | null;
  onBatch?: (event: BatchEvent) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class CleanupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupUsageError';
  }
}

export function targetUsesV2(target: CleanupTarget): boolean {
  return target === 'v2-webhook-bot' || target === 'all';
}

export function targetUsesV1(target: CleanupTarget): boolean {
  return target === 'v1-publisher-mismatch' || target === 'all';
}

function validateOptions(options: CleanupOptions): void {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new CleanupUsageError('Batch size must be a positive integer');
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new CleanupUsageError('Max attempts must be a positive integer');
  }
  if (options.mode === 'apply' && !options.manifestStore) {
    throw new CleanupUsageError('Apply mode requires a manifest store');
  }
  if (options.mode === 'apply' && targetUsesV1(options.target) && !options.blobStore) {
    throw new CleanupUsageError('Apply mode for v1 candidates requires a blob store');
  }
  if (!options.manifestStore && options.mode !== 'dry-run') {
    throw new CleanupUsageError('A manifest store is required outside dry-run mode');
  }
}

async function summarizeV2(db: DrizzleClient['db']): Promise<V2Summary> {
  const [row] = await db
    .select({
      webhook_bot_shared: sql<number>`count(*) filter (where ${cli_sessions_v2.public_id} is not null and ${cli_sessions_v2.kilo_user_id} like ${`${WEBHOOK_BOT_PREFIX}%`})::int`,
      webhook_bot_revoked: sql<number>`count(*) filter (where ${cli_sessions_v2.public_id} is null and ${cli_sessions_v2.kilo_user_id} like ${`${WEBHOOK_BOT_PREFIX}%`})::int`,
      human_shared: sql<number>`count(*) filter (where ${cli_sessions_v2.public_id} is not null and ${cli_sessions_v2.kilo_user_id} not like ${`${BOT_PREFIX}%`})::int`,
      other_bot_shared: sql<number>`count(*) filter (where ${cli_sessions_v2.public_id} is not null and ${cli_sessions_v2.kilo_user_id} like ${`${BOT_PREFIX}%`} and ${cli_sessions_v2.kilo_user_id} not like ${`${WEBHOOK_BOT_PREFIX}%`})::int`,
    })
    .from(cli_sessions_v2)
    .where(
      or(
        isNotNull(cli_sessions_v2.public_id),
        like(cli_sessions_v2.kilo_user_id, `${WEBHOOK_BOT_PREFIX}%`)
      )
    );

  return {
    webhook_bot_shared: row?.webhook_bot_shared ?? 0,
    webhook_bot_revoked: row?.webhook_bot_revoked ?? 0,
    human_shared: row?.human_shared ?? 0,
    other_bot_shared: row?.other_bot_shared ?? 0,
  };
}

async function summarizeV1(db: DrizzleClient['db']): Promise<V1Summary> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      owner_matched: sql<number>`count(*) filter (where ${sharedCliSessions.session_id} is not null and ${sharedCliSessions.kilo_user_id} = ${cliSessions.kilo_user_id})::int`,
      publisher_mismatch: sql<number>`count(*) filter (where ${sharedCliSessions.session_id} is not null and ${sharedCliSessions.kilo_user_id} <> ${cliSessions.kilo_user_id})::int`,
      orphan: sql<number>`count(*) filter (where ${sharedCliSessions.session_id} is null)::int`,
      unmatched: sql<number>`count(*) filter (where ${sharedCliSessions.session_id} is not null and ${cliSessions.session_id} is null)::int`,
    })
    .from(sharedCliSessions)
    .leftJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id));

  return {
    total: row?.total ?? 0,
    owner_matched: row?.owner_matched ?? 0,
    publisher_mismatch: row?.publisher_mismatch ?? 0,
    orphan: row?.orphan ?? 0,
    unmatched: row?.unmatched ?? 0,
  };
}

export async function summarizeCleanup(
  db: DrizzleClient['db'],
  target: CleanupTarget
): Promise<CleanupSummary> {
  const summary: CleanupSummary = {};
  if (targetUsesV2(target)) summary.v2 = await summarizeV2(db);
  if (targetUsesV1(target)) summary.v1 = await summarizeV1(db);
  return summary;
}

function classifyBlobUrls(
  shareId: string,
  row: ShareBlobRow
): { filenames: ShareBlobFilename[]; unsafe: ShareBlobFilename[] } {
  const filenames: ShareBlobFilename[] = [];
  const unsafe: ShareBlobFilename[] = [];

  for (const { column, filename } of SHARE_BLOB_COLUMNS) {
    const url = row[column];
    if (url === null) continue;
    if (url === `shared-sessions/${shareId}/${filename}.json`) {
      filenames.push(filename);
    } else {
      unsafe.push(filename);
    }
  }

  return { filenames, unsafe };
}

async function discoverV2(
  options: CleanupOptions,
  manifest: CleanupManifest,
  persist: () => Promise<void>
): Promise<void> {
  let batchIndex = 0;
  while (true) {
    const cursor = manifest.discovery.v2;
    const cursorCondition = cursor
      ? or(
          gt(cli_sessions_v2.kilo_user_id, cursor.kilo_user_id),
          and(
            eq(cli_sessions_v2.kilo_user_id, cursor.kilo_user_id),
            gt(cli_sessions_v2.session_id, cursor.session_id)
          )
        )
      : undefined;

    const rows = await options.db
      .select({
        session_id: cli_sessions_v2.session_id,
        kilo_user_id: cli_sessions_v2.kilo_user_id,
        public_id: cli_sessions_v2.public_id,
      })
      .from(cli_sessions_v2)
      .where(
        and(
          isNotNull(cli_sessions_v2.public_id),
          like(cli_sessions_v2.kilo_user_id, `${WEBHOOK_BOT_PREFIX}%`),
          cursorCondition
        )
      )
      .orderBy(cli_sessions_v2.kilo_user_id, cli_sessions_v2.session_id)
      .limit(options.batchSize);

    for (const row of rows) {
      if (row.public_id === null) continue;
      const item: V2CleanupItem = {
        kind: 'v2',
        session_id: row.session_id,
        kilo_user_id: row.kilo_user_id,
        public_id: row.public_id,
        state: 'pending',
        attempts: 0,
        last_error: null,
      };
      manifest.items.push(item);
    }

    const last = rows.at(-1);
    if (last) {
      manifest.discovery.v2 = {
        kilo_user_id: last.kilo_user_id,
        session_id: last.session_id,
      };
    }
    await persist();
    await options.onBatch?.({
      phase: 'discover',
      kind: 'v2',
      batch_index: batchIndex,
      size: rows.length,
    });
    batchIndex += 1;

    if (rows.length < options.batchSize) return;
  }
}

async function discoverV1(
  options: CleanupOptions,
  manifest: CleanupManifest,
  persist: () => Promise<void>
): Promise<void> {
  let batchIndex = 0;
  while (true) {
    const cursor = manifest.discovery.v1;
    const rows = await options.db
      .select({
        share_id: sharedCliSessions.share_id,
        session_id: sharedCliSessions.session_id,
        publisher_kilo_user_id: sharedCliSessions.kilo_user_id,
        source_owner_kilo_user_id: cliSessions.kilo_user_id,
        api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
        task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
        ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
        git_state_blob_url: sharedCliSessions.git_state_blob_url,
      })
      .from(sharedCliSessions)
      .innerJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id))
      .where(
        and(
          isNotNull(sharedCliSessions.session_id),
          ne(sharedCliSessions.kilo_user_id, cliSessions.kilo_user_id),
          cursor ? gt(sharedCliSessions.share_id, cursor.share_id) : undefined
        )
      )
      .orderBy(sharedCliSessions.share_id)
      .limit(options.batchSize);

    for (const row of rows) {
      if (row.session_id === null) continue;
      const blobs = classifyBlobUrls(row.share_id, row);
      const item: V1CleanupItem = {
        kind: 'v1',
        share_id: row.share_id,
        session_id: row.session_id,
        publisher_kilo_user_id: row.publisher_kilo_user_id,
        source_owner_kilo_user_id: row.source_owner_kilo_user_id,
        blob_filenames: blobs.filenames,
        unsafe_blob_filenames: blobs.unsafe,
        state: 'pending',
        attempts: 0,
        last_error: null,
      };
      manifest.items.push(item);
    }

    const last = rows.at(-1);
    if (last) manifest.discovery.v1 = { share_id: last.share_id };
    await persist();
    await options.onBatch?.({
      phase: 'discover',
      kind: 'v1',
      batch_index: batchIndex,
      size: rows.length,
    });
    batchIndex += 1;

    if (rows.length < options.batchSize) return;
  }
}

async function retry<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  sleep: (milliseconds: number) => Promise<void>
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch {
      if (attempt + 1 >= maxAttempts) return null;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
    }
  }
  return null;
}

function markFailure(item: CleanupItem, code: string): void {
  item.attempts += 1;
  item.last_error = code;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function applyV2Item(
  item: V2CleanupItem,
  options: CleanupOptions,
  persist: () => Promise<void>
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const result = await retry(
    async () => {
      const [row] = await options.db
        .select({
          kilo_user_id: cli_sessions_v2.kilo_user_id,
          public_id: cli_sessions_v2.public_id,
        })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, item.session_id),
            eq(cli_sessions_v2.kilo_user_id, item.kilo_user_id)
          )
        )
        .limit(1);

      if (!row) return 'done' as const;
      if (!row.kilo_user_id.startsWith(WEBHOOK_BOT_PREFIX)) return 'changed' as const;
      if (row.public_id === null) return 'done' as const;
      if (row.public_id !== item.public_id) return 'changed' as const;

      const updated = await options.db
        .update(cli_sessions_v2)
        .set({
          public_id: null,
          updated_at: sql`${cli_sessions_v2.updated_at}`,
        })
        .where(
          and(
            eq(cli_sessions_v2.session_id, item.session_id),
            eq(cli_sessions_v2.kilo_user_id, item.kilo_user_id),
            eq(cli_sessions_v2.public_id, item.public_id)
          )
        )
        .returning({ session_id: cli_sessions_v2.session_id });

      return updated.length === 1 ? ('done' as const) : ('changed' as const);
    },
    options.maxAttempts,
    sleep
  );

  if (result === null) {
    markFailure(item, 'db_error');
    await persist();
    return;
  }

  item.state = result;
  item.last_error = null;
  await persist();
}

async function applyV1Item(
  item: V1CleanupItem,
  options: CleanupOptions,
  persist: () => Promise<void>
): Promise<number> {
  const blobStore = options.blobStore;
  if (!blobStore) throw new CleanupUsageError('Blob store is required for v1 candidates');
  const sleep = options.sleep ?? defaultSleep;

  if (item.state === 'pending' || item.state === 'revoking') {
    const revalidated = await retry(
      async () => {
        const [row] = await options.db
          .select({
            share_id: sharedCliSessions.share_id,
            session_id: sharedCliSessions.session_id,
            publisher_kilo_user_id: sharedCliSessions.kilo_user_id,
            source_owner_kilo_user_id: cliSessions.kilo_user_id,
            api_conversation_history_blob_url: sharedCliSessions.api_conversation_history_blob_url,
            task_metadata_blob_url: sharedCliSessions.task_metadata_blob_url,
            ui_messages_blob_url: sharedCliSessions.ui_messages_blob_url,
            git_state_blob_url: sharedCliSessions.git_state_blob_url,
          })
          .from(sharedCliSessions)
          .innerJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id))
          .where(eq(sharedCliSessions.share_id, item.share_id))
          .limit(1);

        if (!row) {
          return item.state === 'revoking' ? ('delete' as const) : ('changed' as const);
        }
        if (
          row.session_id === null ||
          row.session_id !== item.session_id ||
          row.publisher_kilo_user_id !== item.publisher_kilo_user_id ||
          row.source_owner_kilo_user_id !== item.source_owner_kilo_user_id ||
          row.publisher_kilo_user_id === row.source_owner_kilo_user_id
        ) {
          return 'changed' as const;
        }

        const blobs = classifyBlobUrls(item.share_id, row);
        if (
          JSON.stringify(blobs.filenames) !== JSON.stringify(item.blob_filenames) ||
          JSON.stringify(blobs.unsafe) !== JSON.stringify(item.unsafe_blob_filenames)
        ) {
          return 'changed' as const;
        }

        return 'delete' as const;
      },
      options.maxAttempts,
      sleep
    );

    if (revalidated === null) {
      markFailure(item, 'db_error');
      await persist();
      return 0;
    }
    if (revalidated === 'changed') {
      item.state = 'changed';
      item.last_error = null;
      await persist();
      return 0;
    }

    item.state = 'revoking';
    item.last_error = null;
    await persist();

    const deleted = await retry(
      async () =>
        options.db
          .delete(sharedCliSessions)
          .where(
            and(
              eq(sharedCliSessions.share_id, item.share_id),
              eq(sharedCliSessions.session_id, item.session_id),
              eq(sharedCliSessions.kilo_user_id, item.publisher_kilo_user_id)
            )
          )
          .returning({ share_id: sharedCliSessions.share_id }),
      options.maxAttempts,
      sleep
    );

    if (deleted === null) {
      markFailure(item, 'db_error');
      await persist();
      return 0;
    }
    if (deleted.length === 0) {
      const [stillThere] = await options.db
        .select({ share_id: sharedCliSessions.share_id })
        .from(sharedCliSessions)
        .where(eq(sharedCliSessions.share_id, item.share_id))
        .limit(1);
      if (stillThere) {
        item.state = 'changed';
        item.last_error = null;
        await persist();
        return 0;
      }
    }

    item.state = 'row_deleted';
    item.last_error = null;
    await persist();
  }

  if (item.state !== 'row_deleted') return 0;

  if (item.blob_filenames.length === 0) {
    item.state = 'done';
    item.last_error = null;
    await persist();
    return 0;
  }

  const deleted = await retry(
    () => blobStore.deleteShareBlobs(item.share_id, item.blob_filenames),
    options.maxAttempts,
    sleep
  );

  if (deleted === null) {
    markFailure(item, 'blob_delete_error');
    await persist();
    return 0;
  }

  item.state = 'done';
  item.last_error = null;
  await persist();
  return item.blob_filenames.length;
}

function countItems(items: CleanupItem[]): {
  completed: number;
  changed: number;
  remaining: number;
  pending_blob_deletes: number;
  failed: number;
  unsafe_blob_items: number;
} {
  let completed = 0;
  let changed = 0;
  let remaining = 0;
  let pendingBlobDeletes = 0;
  let failed = 0;
  let unsafeBlobItems = 0;

  for (const item of items) {
    if (item.kind === 'v1' && item.unsafe_blob_filenames.length > 0) unsafeBlobItems += 1;
    if (item.state === 'done') {
      completed += 1;
      continue;
    }
    if (item.state === 'changed') {
      changed += 1;
      continue;
    }
    remaining += 1;
    if (item.last_error) failed += 1;
    if (item.kind === 'v1' && item.state === 'row_deleted') pendingBlobDeletes += 1;
  }

  return {
    completed,
    changed,
    remaining,
    pending_blob_deletes: pendingBlobDeletes,
    failed,
    unsafe_blob_items: unsafeBlobItems,
  };
}

export async function runCleanup(options: CleanupOptions): Promise<CleanupReport> {
  validateOptions(options);

  if (options.mode === 'dry-run' && !options.manifestStore) {
    return {
      mode: options.mode,
      target: options.target,
      summary: await summarizeCleanup(options.db, options.target),
      manifest_written: false,
      manifest_candidates: null,
      apply: null,
    };
  }

  const store = options.manifestStore;
  if (!store) throw new CleanupUsageError('A manifest store is required');

  let manifest = await store.load();
  if (manifest) {
    if (manifest.target !== options.target) {
      throw new CleanupUsageError('Manifest target does not match the requested target');
    }
    if (manifest.database_identity_hash !== options.databaseIdentityHash) {
      throw new CleanupUsageError('Manifest belongs to a different database');
    }
    if (options.mode === 'apply' && !manifest.discovery_complete) {
      throw new CleanupUsageError(
        'Manifest discovery is incomplete; rerun the dry run before applying'
      );
    }
  } else {
    if (options.mode === 'apply') {
      throw new CleanupUsageError('Apply mode requires a manifest created by a completed dry run');
    }
    manifest = createManifest({
      target: options.target,
      databaseIdentityHash: options.databaseIdentityHash,
    });
    await store.save(manifest);
  }

  const persist = async () => {
    manifest.updated_at = new Date().toISOString();
    await store.save(manifest);
  };

  if (!manifest.discovery_complete) {
    if (targetUsesV2(options.target)) await discoverV2(options, manifest, persist);
    if (targetUsesV1(options.target)) await discoverV1(options, manifest, persist);
    manifest.discovery_complete = true;
    await persist();
  }

  const summary = await summarizeCleanup(options.db, options.target);
  const candidateCounts = {
    v2: manifest.items.filter(item => item.kind === 'v2').length,
    v1: manifest.items.filter(item => item.kind === 'v1').length,
  };

  if (options.mode === 'dry-run') {
    return {
      mode: options.mode,
      target: options.target,
      summary,
      manifest_written: true,
      manifest_candidates: candidateCounts,
      apply: null,
    };
  }

  let batchIndex = 0;
  let blobsDeleted = 0;
  const actionable = manifest.items.filter(
    item => item.state !== 'done' && item.state !== 'changed'
  );
  for (let offset = 0; offset < actionable.length; offset += options.batchSize) {
    const batch = actionable.slice(offset, offset + options.batchSize);
    for (const item of batch) {
      if (item.kind === 'v2') {
        await applyV2Item(item, options, persist);
      } else {
        blobsDeleted += await applyV1Item(item, options, persist);
      }
    }
    await options.onBatch?.({
      phase: 'apply',
      kind: batch[0]?.kind ?? 'v2',
      batch_index: batchIndex,
      size: batch.length,
    });
    batchIndex += 1;
  }

  const counts = countItems(manifest.items);
  return {
    mode: options.mode,
    target: options.target,
    summary,
    manifest_written: true,
    manifest_candidates: candidateCounts,
    apply: {
      completed: counts.completed,
      changed: counts.changed,
      remaining: counts.remaining,
      pending_blob_deletes: counts.pending_blob_deletes,
      failed: counts.failed,
      blobs_deleted: blobsDeleted,
      unsafe_blob_items: counts.unsafe_blob_items,
      complete: counts.remaining === 0,
    },
  };
}
