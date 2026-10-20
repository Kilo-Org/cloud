import assert from 'node:assert/strict';
import { chmod, mkdtemp, stat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cliSessions,
  kilocode_users,
  sharedCliSessions,
} from '@kilocode/db/schema';
import { createBlobStore } from './blob-store';
import {
  runCleanup,
  type BlobStore,
  type CleanupOptions,
  type ShareBlobFilename,
} from './cleanup-core';
import {
  createFileManifestStore,
  createManifest,
  createMemoryManifestStore,
  databaseIdentityHash,
} from './manifest';

const BOT_WEBHOOK = 'bot-webhook-organization-11111111';
const HUMAN_OWNER = 'human-owner-11111111';
const HUMAN_COLLEAGUE = 'human-colleague-11111111';
const OTHER_BOT = 'bot-code-review-organization-11111111';
const NEAR_BOT = 'bot-webhookish-11111111';
const UNRELATED_SHARE = '99999999-9999-4999-8999-999999999999';

const PUBLIC_ID_WEBHOOK = '11111111-1111-4111-8111-111111111111';
const PUBLIC_ID_HUMAN = '22222222-2222-4222-8222-222222222222';
const PUBLIC_ID_OTHER_BOT = '33333333-3333-4333-8333-333333333333';
const PUBLIC_ID_NEAR_BOT = '44444444-4444-4444-8444-444444444444';
const PUBLIC_ID_ROTATED = '55555555-5555-4555-8555-555555555555';

const SESSION_V2_WEBHOOK = 'ses_webhook_111111111111111111';
const SESSION_V2_HUMAN = 'ses_human_22222222222222222222';
const SESSION_V2_OTHER_BOT = 'ses_other_bot_3333333333333333';
const SESSION_V2_NEAR_BOT = 'ses_near_bot_44444444444444444';

const SESSION_V1_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_V1_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_V1_MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const SHARE_OWNER_A = '10000000-0000-4000-8000-000000000001';
const SHARE_MISMATCH_A = '10000000-0000-4000-8000-000000000002';
const SHARE_OWNER_B = '10000000-0000-4000-8000-000000000003';
const SHARE_ORPHAN = '10000000-0000-4000-8000-000000000004';
const SHARE_UNMATCHED = '10000000-0000-4000-8000-000000000005';

const BLOB_FILENAMES: ShareBlobFilename[] = [
  'api_conversation_history',
  'task_metadata',
  'ui_messages',
  'git_state',
];

function blobKey(shareId: string, filename: ShareBlobFilename): string {
  return `shared-sessions/${shareId}/${filename}.json`;
}

class FakeBlobStore implements BlobStore {
  readonly objects = new Set<string>();
  readonly deleted: string[] = [];
  attempts = 0;
  failForShareId: string | null = null;

  add(shareId: string, filenames: readonly ShareBlobFilename[]): void {
    for (const filename of filenames) this.objects.add(blobKey(shareId, filename));
  }

  async deleteShareBlobs(shareId: string, filenames: readonly ShareBlobFilename[]): Promise<void> {
    this.attempts += 1;
    if (this.failForShareId === shareId) {
      throw new Error('simulated blob failure');
    }
    for (const filename of filenames) {
      const key = blobKey(shareId, filename);
      this.deleted.push(key);
      this.objects.delete(key);
    }
  }
}

type ShareTokenEnv = {
  SESSION_SHARE_JWT_SECRET_PROD: { get(): Promise<string | undefined> };
  SESSION_SHARE_TOKEN_MIN_IAT: string | undefined;
  HYPERDRIVE: { connectionString: string };
};

type ShareTokenModule = {
  signSessionShareToken(
    env: ShareTokenEnv,
    params: { sessionId: string; publicId: string }
  ): Promise<string>;
  resolveSessionShareToken(
    env: ShareTokenEnv,
    token: string
  ): Promise<{ sessionId: string } | null>;
};

let client: ReturnType<typeof createDrizzleClient>;
let db: ReturnType<typeof createDrizzleClient>['db'];
let connectionString: string;
let identityHash: string;

before(async () => {
  connectionString = process.env.POSTGRES_URL ?? '';
  if (!connectionString) throw new Error('Set POSTGRES_URL to a disposable local test database');
  const url = new URL(connectionString);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Session share cleanup tests require a local PostgreSQL database');
  }
  if (!url.pathname.includes('test') && !url.pathname.includes('share_cleanup')) {
    throw new Error('Session share cleanup tests require a test-named local database');
  }

  identityHash = databaseIdentityHash(connectionString);
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  db = client.db;

  await db.execute(sql`DROP TABLE IF EXISTS shared_cli_sessions`);
  await db.execute(sql`DROP TABLE IF EXISTS cli_sessions`);
  await db.execute(sql`DROP TABLE IF EXISTS cli_sessions_v2`);
  await db.execute(sql`DROP TABLE IF EXISTS kilocode_users`);

  await db.execute(sql`
    CREATE TABLE kilocode_users (
      id text PRIMARY KEY,
      google_user_name text
    )
  `);
  await db.execute(sql`
    CREATE TABLE cli_sessions (
      session_id uuid PRIMARY KEY,
      kilo_user_id text NOT NULL,
      title text NOT NULL DEFAULT '',
      version integer NOT NULL DEFAULT 0,
      git_url text,
      git_branch text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      api_conversation_history_blob_url text,
      task_metadata_blob_url text,
      ui_messages_blob_url text,
      git_state_blob_url text
    )
  `);
  await db.execute(sql`
    CREATE TABLE shared_cli_sessions (
      share_id uuid PRIMARY KEY,
      session_id uuid,
      kilo_user_id text NOT NULL,
      shared_state text NOT NULL DEFAULT 'public',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      api_conversation_history_blob_url text,
      task_metadata_blob_url text,
      ui_messages_blob_url text,
      git_state_blob_url text
    )
  `);
  await db.execute(sql`
    CREATE TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      version integer NOT NULL DEFAULT 0,
      title text,
      public_id uuid,
      git_url text,
      git_branch text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

after(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE kilocode_users, cli_sessions, shared_cli_sessions, cli_sessions_v2`
  );
});

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`INSERT INTO kilocode_users (id, google_user_name) VALUES (${id}, ${id})`);
}

async function insertV2(params: {
  sessionId: string;
  userId: string;
  publicId: string | null;
  title?: string;
  version?: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO cli_sessions_v2 (session_id, kilo_user_id, public_id, title, version)
    VALUES (
      ${params.sessionId},
      ${params.userId},
      CAST(${params.publicId} AS uuid),
      ${params.title ?? `title for ${params.sessionId}`},
      ${params.version ?? 7}
    )
  `);
}

async function insertV1Session(sessionId: string, owner: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO cli_sessions (session_id, kilo_user_id, title, version)
    VALUES (CAST(${sessionId} AS uuid), ${owner}, ${`session ${sessionId}`}, 3)
  `);
}

async function insertShare(params: {
  shareId: string;
  sessionId: string | null;
  publisher: string;
  filenames?: readonly ShareBlobFilename[];
  blobStore?: FakeBlobStore;
}): Promise<void> {
  const filenames = params.filenames ?? BLOB_FILENAMES;
  const urlFor = (filename: ShareBlobFilename) =>
    filenames.includes(filename) ? blobKey(params.shareId, filename) : null;

  await db.execute(sql`
    INSERT INTO shared_cli_sessions (
      share_id, session_id, kilo_user_id, shared_state,
      api_conversation_history_blob_url, task_metadata_blob_url,
      ui_messages_blob_url, git_state_blob_url
    ) VALUES (
      CAST(${params.shareId} AS uuid),
      CAST(${params.sessionId} AS uuid),
      ${params.publisher},
      'public',
      ${urlFor('api_conversation_history')},
      ${urlFor('task_metadata')},
      ${urlFor('ui_messages')},
      ${urlFor('git_state')}
    )
  `);
  params.blobStore?.add(params.shareId, filenames);
}

async function createRunOptions(
  overrides: Partial<CleanupOptions> & Pick<CleanupOptions, 'mode' | 'target'>
): Promise<CleanupOptions> {
  return {
    db,
    databaseIdentityHash: identityHash,
    batchSize: 100,
    maxAttempts: 3,
    manifestStore: null,
    blobStore: null,
    sleep: async () => undefined,
    ...overrides,
  };
}

async function readV2Row(sessionId: string, userId: string) {
  const [row] = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      kilo_user_id: cli_sessions_v2.kilo_user_id,
      public_id: cli_sessions_v2.public_id,
      title: cli_sessions_v2.title,
      version: cli_sessions_v2.version,
      updated_at: cli_sessions_v2.updated_at,
    })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId)))
    .limit(1);
  return row;
}

async function readShare(shareId: string) {
  const [row] = await db
    .select()
    .from(sharedCliSessions)
    .where(eq(sharedCliSessions.share_id, shareId))
    .limit(1);
  return row;
}

async function resolveV1PublicShare(shareId: string) {
  return db
    .select({
      shareId: sharedCliSessions.share_id,
      sessionId: sharedCliSessions.session_id,
      ownerName: kilocode_users.google_user_name,
      title: cliSessions.title,
      uiMessagesBlobUrl: sharedCliSessions.ui_messages_blob_url,
    })
    .from(sharedCliSessions)
    .leftJoin(cliSessions, eq(sharedCliSessions.session_id, cliSessions.session_id))
    .leftJoin(kilocode_users, eq(cliSessions.kilo_user_id, kilocode_users.id))
    .where(
      and(eq(sharedCliSessions.share_id, shareId), eq(sharedCliSessions.shared_state, 'public'))
    )
    .limit(1);
}

async function loadShareTokenModule(): Promise<ShareTokenModule> {
  const moduleUrl = new URL(
    '../../services/session-ingest/src/services/session-share-token.ts',
    import.meta.url
  ).href;
  return (await import(moduleUrl)) as ShareTokenModule;
}

function tokenEnv(secret: string): ShareTokenEnv {
  return {
    SESSION_SHARE_JWT_SECRET_PROD: { get: async () => secret },
    SESSION_SHARE_TOKEN_MIN_IAT: undefined,
    HYPERDRIVE: { connectionString },
  };
}

void describe('session share maintenance', () => {
  void it('dry run summarizes categories without changing rows or blobs', async () => {
    await insertUser(BOT_WEBHOOK);
    await insertUser(HUMAN_OWNER);
    await insertUser(HUMAN_COLLEAGUE);
    await insertUser(OTHER_BOT);
    await insertUser(NEAR_BOT);

    await insertV2({
      sessionId: SESSION_V2_WEBHOOK,
      userId: BOT_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
    });
    await insertV2({
      sessionId: 'ses_webhook_revoked',
      userId: 'bot-webhook-organization-revoked',
      publicId: null,
    });
    await insertV2({
      sessionId: SESSION_V2_HUMAN,
      userId: HUMAN_OWNER,
      publicId: PUBLIC_ID_HUMAN,
    });
    await insertV2({
      sessionId: SESSION_V2_OTHER_BOT,
      userId: OTHER_BOT,
      publicId: PUBLIC_ID_OTHER_BOT,
    });
    await insertV2({
      sessionId: SESSION_V2_NEAR_BOT,
      userId: NEAR_BOT,
      publicId: PUBLIC_ID_NEAR_BOT,
    });

    await insertV1Session(SESSION_V1_A, HUMAN_OWNER);
    await insertV1Session(SESSION_V1_B, HUMAN_OWNER);
    await insertShare({
      shareId: SHARE_OWNER_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_OWNER,
    });
    await insertShare({
      shareId: SHARE_MISMATCH_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_COLLEAGUE,
    });
    await insertShare({
      shareId: SHARE_OWNER_B,
      sessionId: SESSION_V1_B,
      publisher: HUMAN_OWNER,
    });
    await insertShare({ shareId: SHARE_ORPHAN, sessionId: null, publisher: HUMAN_OWNER });
    await insertShare({
      shareId: SHARE_UNMATCHED,
      sessionId: SESSION_V1_MISSING,
      publisher: HUMAN_OWNER,
    });

    const report = await runCleanup(await createRunOptions({ mode: 'dry-run', target: 'all' }));

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.manifest_written, false);
    assert.deepEqual(report.summary.v2, {
      webhook_bot_shared: 1,
      webhook_bot_revoked: 1,
      human_shared: 1,
      other_bot_shared: 2,
    });
    assert.deepEqual(report.summary.v1, {
      total: 5,
      owner_matched: 2,
      publisher_mismatch: 1,
      orphan: 1,
      unmatched: 1,
    });

    assert.equal((await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK))?.public_id, PUBLIC_ID_WEBHOOK);
    assert.equal((await readV2Row(SESSION_V2_HUMAN, HUMAN_OWNER))?.public_id, PUBLIC_ID_HUMAN);
    assert.ok(await readShare(SHARE_MISMATCH_A));
  });

  void it('revokes only webhook bot v2 public ids and leaves valid shares resolvable', async () => {
    await insertUser(BOT_WEBHOOK);
    await insertUser(HUMAN_OWNER);
    await insertUser(OTHER_BOT);
    await insertUser(NEAR_BOT);

    await insertV2({
      sessionId: SESSION_V2_WEBHOOK,
      userId: BOT_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
      title: 'webhook session',
      version: 11,
    });
    await insertV2({
      sessionId: SESSION_V2_HUMAN,
      userId: HUMAN_OWNER,
      publicId: PUBLIC_ID_HUMAN,
    });
    await insertV2({
      sessionId: SESSION_V2_OTHER_BOT,
      userId: OTHER_BOT,
      publicId: PUBLIC_ID_OTHER_BOT,
    });
    await insertV2({
      sessionId: SESSION_V2_NEAR_BOT,
      userId: NEAR_BOT,
      publicId: PUBLIC_ID_NEAR_BOT,
    });
    await insertV2({
      sessionId: 'ses_webhook_already_revoked',
      userId: 'bot-webhook-organization-revoked',
      publicId: null,
    });

    const shareTokens = await loadShareTokenModule();
    const env = tokenEnv('session-share-test-secret');
    const webhookToken = await shareTokens.signSessionShareToken(env, {
      sessionId: SESSION_V2_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
    });
    const humanToken = await shareTokens.signSessionShareToken(env, {
      sessionId: SESSION_V2_HUMAN,
      publicId: PUBLIC_ID_HUMAN,
    });

    assert.equal(
      (await shareTokens.resolveSessionShareToken(env, webhookToken))?.sessionId,
      SESSION_V2_WEBHOOK
    );
    assert.equal(
      (await shareTokens.resolveSessionShareToken(env, humanToken))?.sessionId,
      SESSION_V2_HUMAN
    );

    const store = createMemoryManifestStore();
    const reviewed = await runCleanup(
      await createRunOptions({ mode: 'dry-run', target: 'v2-webhook-bot', manifestStore: store })
    );
    assert.equal(reviewed.manifest_candidates?.v2, 1);

    const updatedAtBefore = (await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK))?.updated_at;
    const report = await runCleanup(
      await createRunOptions({ mode: 'apply', target: 'v2-webhook-bot', manifestStore: store })
    );

    assert.equal(report.apply?.complete, true);
    assert.equal(report.apply?.completed, 1);
    assert.equal(report.manifest_candidates?.v2, 1);

    const webhookRow = await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK);
    assert.equal(webhookRow?.public_id, null);
    assert.equal(webhookRow?.title, 'webhook session');
    assert.equal(webhookRow?.version, 11);
    assert.equal(webhookRow?.updated_at, updatedAtBefore);

    assert.equal((await readV2Row(SESSION_V2_HUMAN, HUMAN_OWNER))?.public_id, PUBLIC_ID_HUMAN);
    assert.equal(
      (await readV2Row(SESSION_V2_OTHER_BOT, OTHER_BOT))?.public_id,
      PUBLIC_ID_OTHER_BOT
    );
    assert.equal((await readV2Row(SESSION_V2_NEAR_BOT, NEAR_BOT))?.public_id, PUBLIC_ID_NEAR_BOT);

    assert.equal(await shareTokens.resolveSessionShareToken(env, webhookToken), null);
    assert.equal(
      (await shareTokens.resolveSessionShareToken(env, humanToken))?.sessionId,
      SESSION_V2_HUMAN
    );

    const repeat = await runCleanup(
      await createRunOptions({ mode: 'apply', target: 'v2-webhook-bot', manifestStore: store })
    );
    assert.equal(repeat.apply?.complete, true);
    assert.equal(repeat.apply?.completed, 1);
  });

  void it('revokes only mismatched v1 shares and deletes only their captured blobs', async () => {
    await insertUser(HUMAN_OWNER);
    await insertUser(HUMAN_COLLEAGUE);
    await insertV1Session(SESSION_V1_A, HUMAN_OWNER);

    const blobStore = new FakeBlobStore();
    await insertShare({
      shareId: SHARE_OWNER_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_OWNER,
      blobStore,
    });
    await insertShare({
      shareId: SHARE_MISMATCH_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_COLLEAGUE,
      blobStore,
    });
    await insertShare({
      shareId: SHARE_ORPHAN,
      sessionId: null,
      publisher: HUMAN_OWNER,
      blobStore,
    });
    await insertShare({
      shareId: SHARE_UNMATCHED,
      sessionId: SESSION_V1_MISSING,
      publisher: HUMAN_OWNER,
      blobStore,
    });
    blobStore.objects.add(`shared-sessions/${UNRELATED_SHARE}/ui_messages.json`);

    assert.equal((await resolveV1PublicShare(SHARE_MISMATCH_A)).length, 1);
    assert.equal((await resolveV1PublicShare(SHARE_OWNER_A)).length, 1);

    const store = createMemoryManifestStore();
    const reviewed = await runCleanup(
      await createRunOptions({
        mode: 'dry-run',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
      })
    );
    assert.equal(reviewed.manifest_candidates?.v1, 1);

    const report = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
        blobStore,
      })
    );

    assert.equal(report.apply?.complete, true);
    assert.equal(report.manifest_candidates?.v1, 1);
    assert.equal(report.apply?.blobs_deleted, BLOB_FILENAMES.length);

    assert.equal(await readShare(SHARE_MISMATCH_A), undefined);
    assert.ok(await readShare(SHARE_OWNER_A));
    assert.ok(await readShare(SHARE_ORPHAN));
    assert.ok(await readShare(SHARE_UNMATCHED));

    assert.deepEqual(
      [...blobStore.objects].sort(),
      [
        ...BLOB_FILENAMES.map(filename => blobKey(SHARE_OWNER_A, filename)),
        ...BLOB_FILENAMES.map(filename => blobKey(SHARE_ORPHAN, filename)),
        ...BLOB_FILENAMES.map(filename => blobKey(SHARE_UNMATCHED, filename)),
        `shared-sessions/${UNRELATED_SHARE}/ui_messages.json`,
      ].sort()
    );
    assert.equal((await resolveV1PublicShare(SHARE_MISMATCH_A)).length, 0);
    assert.equal((await resolveV1PublicShare(SHARE_OWNER_A)).length, 1);

    const deletedBefore = [...blobStore.deleted];
    const repeat = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
        blobStore,
      })
    );
    assert.equal(repeat.apply?.complete, true);
    assert.equal(repeat.apply?.blobs_deleted, 0);
    assert.deepEqual(blobStore.deleted, deletedBefore);
  });

  void it('skips reviewed candidates that changed after the manifest was written', async () => {
    await insertUser(BOT_WEBHOOK);
    await insertUser(HUMAN_OWNER);
    await insertUser(HUMAN_COLLEAGUE);
    await insertV1Session(SESSION_V1_A, HUMAN_OWNER);

    await insertV2({
      sessionId: SESSION_V2_WEBHOOK,
      userId: BOT_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
    });
    await insertShare({
      shareId: SHARE_MISMATCH_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_COLLEAGUE,
    });

    const store = createMemoryManifestStore();
    const dryRun = await runCleanup(
      await createRunOptions({ mode: 'dry-run', target: 'all', manifestStore: store })
    );
    assert.equal(dryRun.manifest_candidates?.v2, 1);
    assert.equal(dryRun.manifest_candidates?.v1, 1);

    await db
      .update(cli_sessions_v2)
      .set({ public_id: PUBLIC_ID_ROTATED })
      .where(
        and(
          eq(cli_sessions_v2.session_id, SESSION_V2_WEBHOOK),
          eq(cli_sessions_v2.kilo_user_id, BOT_WEBHOOK)
        )
      );
    await db
      .update(sharedCliSessions)
      .set({ kilo_user_id: HUMAN_OWNER })
      .where(eq(sharedCliSessions.share_id, SHARE_MISMATCH_A));

    await insertV2({
      sessionId: 'ses_webhook_added_later',
      userId: 'bot-webhook-organization-later',
      publicId: PUBLIC_ID_ROTATED,
    });

    const blobStore = new FakeBlobStore();
    const report = await runCleanup(
      await createRunOptions({ mode: 'apply', target: 'all', manifestStore: store, blobStore })
    );

    assert.equal(report.apply?.changed, 2);
    assert.equal(report.apply?.remaining, 0);
    assert.equal(report.apply?.complete, true);
    assert.equal(blobStore.deleted.length, 0);
    assert.equal((await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK))?.public_id, PUBLIC_ID_ROTATED);
    assert.ok(await readShare(SHARE_MISMATCH_A));
    assert.equal(
      (await readV2Row('ses_webhook_added_later', 'bot-webhook-organization-later'))?.public_id,
      PUBLIC_ID_ROTATED
    );
  });

  void it('reports partial completion on blob failure and resumes after retry', async () => {
    await insertUser(HUMAN_OWNER);
    await insertUser(HUMAN_COLLEAGUE);
    await insertV1Session(SESSION_V1_A, HUMAN_OWNER);

    const blobStore = new FakeBlobStore();
    await insertShare({
      shareId: SHARE_MISMATCH_A,
      sessionId: SESSION_V1_A,
      publisher: HUMAN_COLLEAGUE,
      filenames: ['ui_messages', 'git_state'],
      blobStore,
    });
    blobStore.failForShareId = SHARE_MISMATCH_A;

    const store = createMemoryManifestStore();
    await runCleanup(
      await createRunOptions({
        mode: 'dry-run',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
      })
    );

    const first = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
        blobStore,
        maxAttempts: 2,
      })
    );

    assert.equal(first.apply?.complete, false);
    assert.equal(first.apply?.failed, 1);
    assert.equal(first.apply?.pending_blob_deletes, 1);
    assert.equal(first.apply?.remaining, 1);
    assert.equal(first.apply?.blobs_deleted, 0);
    assert.equal(blobStore.attempts, 2);
    assert.equal(await readShare(SHARE_MISMATCH_A), undefined);
    assert.ok(blobStore.objects.has(blobKey(SHARE_MISMATCH_A, 'ui_messages')));
    assert.ok(blobStore.objects.has(blobKey(SHARE_MISMATCH_A, 'git_state')));

    const persisted = await store.load();
    const persistedItem = persisted?.items.find(item => item.kind === 'v1');
    assert.equal(persistedItem?.state, 'row_deleted');
    assert.equal(persistedItem?.last_error, 'blob_delete_error');
    assert.deepEqual(persistedItem?.blob_filenames, ['ui_messages', 'git_state']);

    blobStore.failForShareId = null;
    const resumed = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
        blobStore,
        maxAttempts: 2,
      })
    );

    assert.equal(resumed.apply?.complete, true);
    assert.equal(resumed.apply?.remaining, 0);
    assert.equal(resumed.apply?.blobs_deleted, 2);
    assert.ok(!blobStore.objects.has(blobKey(SHARE_MISMATCH_A, 'ui_messages')));
    assert.ok(!blobStore.objects.has(blobKey(SHARE_MISMATCH_A, 'git_state')));

    const deletedBefore = [...blobStore.deleted];
    const repeat = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'v1-publisher-mismatch',
        manifestStore: store,
        blobStore,
        maxAttempts: 2,
      })
    );
    assert.equal(repeat.apply?.complete, true);
    assert.equal(repeat.apply?.blobs_deleted, 0);
    assert.deepEqual(blobStore.deleted, deletedBefore);
  });

  void it('processes candidates in bounded batches', async () => {
    for (let index = 0; index < 5; index += 1) {
      await insertV2({
        sessionId: `ses_batch_${index}`,
        userId: `bot-webhook-organization-${index}`,
        publicId: `0000000${index}-0000-4000-8000-000000000000`,
      });
    }
    await insertUser(HUMAN_OWNER);
    await insertUser(HUMAN_COLLEAGUE);
    await insertV1Session(SESSION_V1_A, HUMAN_OWNER);
    for (let index = 0; index < 3; index += 1) {
      await insertShare({
        shareId: `2000000${index}-0000-4000-8000-000000000000`,
        sessionId: SESSION_V1_A,
        publisher: HUMAN_COLLEAGUE,
        filenames: ['ui_messages'],
      });
    }

    const events: Array<{ phase: string; kind: string; size: number }> = [];
    const store = createMemoryManifestStore();
    const blobStore = new FakeBlobStore();
    await runCleanup(
      await createRunOptions({
        mode: 'dry-run',
        target: 'all',
        manifestStore: store,
        batchSize: 2,
        onBatch: event => {
          events.push({ phase: event.phase, kind: event.kind, size: event.size });
        },
      })
    );
    const report = await runCleanup(
      await createRunOptions({
        mode: 'apply',
        target: 'all',
        manifestStore: store,
        blobStore,
        batchSize: 2,
        onBatch: event => {
          events.push({ phase: event.phase, kind: event.kind, size: event.size });
        },
      })
    );

    assert.equal(report.apply?.complete, true);
    assert.equal(report.manifest_candidates?.v2, 5);
    assert.equal(report.manifest_candidates?.v1, 3);
    assert.ok(
      events.filter(event => event.phase === 'discover' && event.kind === 'v2').length >= 3
    );
    assert.ok(
      events.filter(event => event.phase === 'discover' && event.kind === 'v1').length >= 2
    );
    assert.ok(events.filter(event => event.phase === 'apply').length >= 4);
    assert.ok(events.every(event => event.size <= 2));
  });

  void it('requires a completed reviewed manifest before applying', async () => {
    await insertUser(BOT_WEBHOOK);
    await insertV2({
      sessionId: SESSION_V2_WEBHOOK,
      userId: BOT_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
    });

    await assert.rejects(
      runCleanup(
        await createRunOptions({
          mode: 'apply',
          target: 'v2-webhook-bot',
          manifestStore: createMemoryManifestStore(),
        })
      ),
      /completed dry run/
    );
    assert.equal((await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK))?.public_id, PUBLIC_ID_WEBHOOK);

    const incomplete = createMemoryManifestStore(
      createManifest({ target: 'v2-webhook-bot', databaseIdentityHash: identityHash })
    );
    await assert.rejects(
      runCleanup(
        await createRunOptions({
          mode: 'apply',
          target: 'v2-webhook-bot',
          manifestStore: incomplete,
        })
      ),
      /discovery is incomplete/
    );
    assert.equal((await readV2Row(SESSION_V2_WEBHOOK, BOT_WEBHOOK))?.public_id, PUBLIC_ID_WEBHOOK);
  });

  void it('propagates adapter delete failures and maps share blob keys', async () => {
    const calls: Array<{
      shareId: string;
      blobs: Array<{ folderName: string; filename: ShareBlobFilename }>;
      options?: { signal?: AbortSignal };
    }> = [];
    const signal = new AbortController().signal;
    const store = createBlobStore(async (shareId, blobs, options) => {
      calls.push({ shareId, blobs, options });
      throw new Error('delete failed');
    });

    await assert.rejects(
      store.deleteShareBlobs(SHARE_MISMATCH_A, ['ui_messages', 'git_state'], { signal }),
      /delete failed/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.shareId, SHARE_MISMATCH_A);
    assert.deepEqual(calls[0]?.blobs, [
      { folderName: 'shared-sessions', filename: 'ui_messages' },
      { folderName: 'shared-sessions', filename: 'git_state' },
    ]);
    assert.equal(calls[0]?.options?.signal, signal);
  });

  void it('writes a private manifest and refuses repository paths', async () => {
    await insertUser(BOT_WEBHOOK);
    await insertV2({
      sessionId: SESSION_V2_WEBHOOK,
      userId: BOT_WEBHOOK,
      publicId: PUBLIC_ID_WEBHOOK,
    });

    assert.throws(
      () => createFileManifestStore(path.join(process.cwd(), 'session-share-manifest.json')),
      /outside the repository/
    );
    assert.throws(
      () => createFileManifestStore(path.join(process.cwd(), '..manifest.json')),
      /outside the repository/
    );

    const linkRoot = await mkdtemp(path.join(tmpdir(), 'session-share-link-'));
    const linkPath = path.join(linkRoot, 'repo-link');
    await symlink(process.cwd(), linkPath, 'dir');
    try {
      assert.throws(
        () => createFileManifestStore(path.join(linkPath, 'manifest.json')),
        /outside the repository/
      );
    } finally {
      await unlink(linkPath);
    }

    const directory = await mkdtemp(path.join(tmpdir(), 'session-share-manifest-'));
    const manifestPath = path.join(directory, 'manifest.json');
    const store = createFileManifestStore(manifestPath);
    const report = await runCleanup(
      await createRunOptions({
        mode: 'dry-run',
        target: 'v2-webhook-bot',
        manifestStore: store,
      })
    );

    assert.equal(report.manifest_written, true);
    assert.equal(report.manifest_candidates?.v2, 1);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o077, 0);
    assert.equal((await store.load())?.items.length, 1);

    const createdDirectory = path.join(directory, 'nested');
    const createdStore = createFileManifestStore(path.join(createdDirectory, 'manifest.json'));
    await createdStore.save(
      createManifest({ target: 'v2-webhook-bot', databaseIdentityHash: identityHash })
    );
    assert.equal((await stat(createdDirectory)).mode & 0o077, 0);
    assert.equal((await stat(path.join(createdDirectory, 'manifest.json'))).mode & 0o777, 0o600);

    const sharedDirectory = await mkdtemp(path.join(tmpdir(), 'session-share-parent-'));
    await chmod(sharedDirectory, 0o755);
    const sharedStore = createFileManifestStore(path.join(sharedDirectory, 'manifest.json'));
    await assert.rejects(
      sharedStore.save(
        createManifest({ target: 'v2-webhook-bot', databaseIdentityHash: identityHash })
      ),
      /accessible by group or other users/
    );
    assert.equal((await stat(sharedDirectory)).mode & 0o777, 0o755);

    await chmod(manifestPath, 0o644);
    await assert.rejects(store.load(), /accessible by group or other users/);
  });
});
