import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { coding_plan_key_inventory, openai_chatgpt_connections } from '@kilocode/db/schema';
import type { EncryptedData } from '@kilocode/db/schema-types';
import {
  legacyCiphertextDigest,
  sealDualWrittenCredential,
} from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  OPENAI_CHATGPT_KMS_PROVIDER_ID,
  openOpenAiChatGptConnection,
  sealOpenAiChatGptConnection,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/connection-encryption';
import type { OpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/types';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import {
  TEST_BYOK_DATA_KEY,
  isFakeByokKmsRequest,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  CODING_PLAN_INVENTORY_KMS_PROVIDER_ID,
  openCodingPlanInventoryCredential,
} from '@/lib/coding-plans/inventory-credential-encryption';
import {
  CREDENTIAL_KMS_BACKFILL_ACTOR,
  backfillCredentialKmsEnvelopes,
  type CredentialKmsBackfillStoreSummary,
} from '@/lib/credential-kms-backfill';

const kms = useFakeByokKms();

const testDataKey = {
  data_key: TEST_BYOK_DATA_KEY,
  wrapped_dek: 'wrapped',
  kms_key_id: 'alias/test',
  kms_key_version: '1',
};

const STALE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function connectionPayload(
  overrides: Partial<OpenAiChatGptConnection> = {}
): OpenAiChatGptConnection {
  return {
    access_token: 'access-token-old',
    refresh_token: 'refresh-token-old',
    expires_at: 1_800_000_000,
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    connected_at: STALE_TIMESTAMP,
    status: 'connected',
    ...overrides,
  };
}

function legacy(plaintext: string): EncryptedData {
  return encryptApiKey(plaintext, BYOK_ENCRYPTION_KEY);
}

let fingerprintCounter = 0;

async function insertInventoryRow(
  values: Partial<typeof coding_plan_key_inventory.$inferInsert> = {}
): Promise<string> {
  fingerprintCounter += 1;
  const [row] = await db
    .insert(coding_plan_key_inventory)
    .values({
      plan_id: 'minimax-token-plan-plus',
      provider_id: 'minimax',
      upstream_plan_id: `upstream-${fingerprintCounter}`,
      credential_fingerprint: `fingerprint-${fingerprintCounter}`,
      encrypted_api_key: legacy(`sk-inventory-${fingerprintCounter}`),
      updated_at: STALE_TIMESTAMP,
      ...values,
    })
    .returning({ id: coding_plan_key_inventory.id });
  return row.id;
}

async function insertConnectionRow(
  values: Partial<typeof openai_chatgpt_connections.$inferInsert> & { kilo_user_id: string | null }
): Promise<string> {
  const [row] = await db
    .insert(openai_chatgpt_connections)
    .values({
      encrypted_connection: legacy(JSON.stringify(connectionPayload())),
      created_by: values.kilo_user_id ?? 'deleted-user',
      updated_at: STALE_TIMESTAMP,
      ...values,
    })
    .returning({ id: openai_chatgpt_connections.id });
  return row.id;
}

async function readInventoryRow(id: string) {
  const [row] = await db
    .select()
    .from(coding_plan_key_inventory)
    .where(eq(coding_plan_key_inventory.id, id));
  return row;
}

async function readConnectionRow(id: string) {
  const [row] = await db
    .select()
    .from(openai_chatgpt_connections)
    .where(eq(openai_chatgpt_connections.id, id));
  return row;
}

async function runBackfill(options: { deadlineAt?: number; batchSize?: number } = {}) {
  const [inventory, connections] = await backfillCredentialKmsEnvelopes({
    deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
    batchSize: options.batchSize,
  });
  return { inventory, connections };
}

function summaryCounts(summary: CredentialKmsBackfillStoreSummary) {
  return {
    migrated: summary.migrated,
    skippedConcurrentWrite: summary.skippedConcurrentWrite,
    failed: summary.failed,
    remaining: summary.remaining,
    errorName: summary.errorName,
  };
}

/** Runs `onDataKey` when the backfill requests a data key, before the key is returned. */
function interceptDataKeyRequests(onDataKey: (body: Record<string, unknown>) => Promise<void>) {
  const fakeFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isFakeByokKmsRequest(input) && String(input).endsWith('/data-key')) {
      await onDataKey(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    return fakeFetch(input, init);
  };
}

function failKmsRequests(path: '/data-key' | '/decrypt') {
  const fakeFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isFakeByokKmsRequest(input) && String(input).endsWith(path)) {
      return new Response('{}', { status: 403 });
    }
    return fakeFetch(input, init);
  };
}

describe('backfillCredentialKmsEnvelopes', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('completes with zero remaining when there is nothing to migrate', async () => {
    const { inventory, connections } = await runBackfill();

    const done = {
      migrated: 0,
      skippedConcurrentWrite: 0,
      failed: { legacy_unreadable: 0, kms: 0, database: 0 },
      remaining: 0,
      errorName: null,
    };
    expect(summaryCounts(inventory)).toEqual(done);
    expect(summaryCounts(connections)).toEqual(done);
    expect(kms.requests).toEqual([]);
  });

  test('gives an inventory credential an envelope bound to its row and keeps the static copy', async () => {
    const id = await insertInventoryRow({ encrypted_api_key: legacy('sk-pooled-secret') });
    const before = await readInventoryRow(id);

    const { inventory } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 1, remaining: 0 });
    const after = await readInventoryRow(id);
    expect(after.encrypted_api_key).toEqual(before.encrypted_api_key);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.encrypted_api_key_envelope?.legacy_digest).toBe(
      legacyCiphertextDigest(before.encrypted_api_key!)
    );
    expect(JSON.stringify(after.encrypted_api_key_envelope)).not.toContain('sk-pooled-secret');
    expect(kms.requests).toEqual([
      {
        path: '/data-key',
        body: {
          key_id: id,
          owner_type: 'organization',
          owner_id: KILO_ORGANIZATION_ID,
          provider_id: CODING_PLAN_INVENTORY_KMS_PROVIDER_ID,
          actor_user_id: CREDENTIAL_KMS_BACKFILL_ACTOR,
        },
      },
    ]);

    kms.requests.length = 0;
    await expect(openCodingPlanInventoryCredential(after)).resolves.toBe('sk-pooled-secret');
    expect(kms.requests.map(request => request.path)).toEqual(['/decrypt']);
  });

  test('gives each ChatGPT connection an envelope bound to its owner', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Backfill org', user.id, 0);
    const personalId = await insertConnectionRow({ kilo_user_id: user.id });
    const sharedId = await insertConnectionRow({
      kilo_user_id: user.id,
      organization_id: organization.id,
      is_shared_services: true,
    });
    const personalBefore = await readConnectionRow(personalId);

    const { connections } = await runBackfill();

    expect(summaryCounts(connections)).toMatchObject({ migrated: 2, remaining: 0 });
    const personal = await readConnectionRow(personalId);
    const shared = await readConnectionRow(sharedId);
    expect(personal.updated_at).toBe(personalBefore.updated_at);
    expect(personal.encrypted_connection).toEqual(personalBefore.encrypted_connection);
    const bodies = kms.requests.map(request => request.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          key_id: personal.encrypted_connection_envelope?.key_id,
          owner_type: 'user',
          owner_id: user.id,
          provider_id: `${OPENAI_CHATGPT_KMS_PROVIDER_ID}:personal`,
          actor_user_id: CREDENTIAL_KMS_BACKFILL_ACTOR,
        },
        {
          key_id: shared.encrypted_connection_envelope?.key_id,
          owner_type: 'organization',
          owner_id: organization.id,
          provider_id: `${OPENAI_CHATGPT_KMS_PROVIDER_ID}:shared-services`,
          actor_user_id: CREDENTIAL_KMS_BACKFILL_ACTOR,
        },
      ])
    );
    for (const row of [personal, shared]) {
      expect(row.encrypted_connection_envelope?.legacy_digest).toBe(
        legacyCiphertextDigest(row.encrypted_connection)
      );
      await expect(openOpenAiChatGptConnection(row)).resolves.toEqual(connectionPayload());
    }
  });

  test('is idempotent: a second run migrates nothing and requests no data key', async () => {
    const user = await insertTestUser();
    await insertInventoryRow();
    await insertConnectionRow({ kilo_user_id: user.id });
    await runBackfill();
    const inventoryBefore = await db.select().from(coding_plan_key_inventory);
    const connectionsBefore = await db.select().from(openai_chatgpt_connections);
    kms.requests.length = 0;

    const { inventory, connections } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 0, remaining: 0 });
    expect(summaryCounts(connections)).toMatchObject({ migrated: 0, remaining: 0 });
    expect(kms.requests).toEqual([]);
    await expect(db.select().from(coding_plan_key_inventory)).resolves.toEqual(inventoryBefore);
    await expect(db.select().from(openai_chatgpt_connections)).resolves.toEqual(connectionsBefore);
  });

  test('leaves rows written by the new writers alone and ignores removed inventory credentials', async () => {
    const user = await insertTestUser();
    const sealed = sealDualWrittenCredential('sk-dual-written', testDataKey);
    await insertInventoryRow({
      encrypted_api_key: sealed.legacy,
      encrypted_api_key_envelope: sealed.envelope,
    });
    await insertInventoryRow({ encrypted_api_key: null, status: 'revoked' });
    await insertConnectionRow({
      kilo_user_id: user.id,
      ...sealOpenAiChatGptConnection(connectionPayload(), {
        keyId: crypto.randomUUID(),
        dataKey: testDataKey,
      }),
    });

    const { inventory, connections } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 0, remaining: 0 });
    expect(summaryCounts(connections)).toMatchObject({ migrated: 0, remaining: 0 });
    expect(kms.requests).toEqual([]);
  });

  test('re-creates an envelope made stale by a static-key write of the previous deployment', async () => {
    const user = await insertTestUser();
    const sealed = sealDualWrittenCredential('sk-before-rollback', testDataKey);
    const inventoryId = await insertInventoryRow({
      encrypted_api_key: sealed.legacy,
      encrypted_api_key_envelope: sealed.envelope,
    });
    const connectionId = await insertConnectionRow({
      kilo_user_id: user.id,
      ...sealOpenAiChatGptConnection(connectionPayload(), {
        keyId: crypto.randomUUID(),
        dataKey: testDataKey,
      }),
    });
    // The previous deployment rotates the credential and the tokens, writing only the
    // static-key columns it knows about.
    const rotated = connectionPayload({
      access_token: 'access-token-new',
      refresh_token: 'refresh-token-new',
    });
    await db
      .update(coding_plan_key_inventory)
      .set({ encrypted_api_key: legacy('sk-after-rollback') })
      .where(eq(coding_plan_key_inventory.id, inventoryId));
    await db
      .update(openai_chatgpt_connections)
      .set({ encrypted_connection: legacy(JSON.stringify(rotated)) })
      .where(eq(openai_chatgpt_connections.id, connectionId));

    // Before the backfill runs, readers already ignore the stale envelopes.
    await expect(
      openCodingPlanInventoryCredential(await readInventoryRow(inventoryId))
    ).resolves.toBe('sk-after-rollback');
    await expect(
      openOpenAiChatGptConnection(await readConnectionRow(connectionId))
    ).resolves.toEqual(rotated);

    const { inventory, connections } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 1, remaining: 0 });
    expect(summaryCounts(connections)).toMatchObject({ migrated: 1, remaining: 0 });
    kms.requests.length = 0;
    await expect(
      openCodingPlanInventoryCredential(await readInventoryRow(inventoryId))
    ).resolves.toBe('sk-after-rollback');
    await expect(
      openOpenAiChatGptConnection(await readConnectionRow(connectionId))
    ).resolves.toEqual(rotated);
    expect(kms.requests.map(request => request.path)).toEqual(['/decrypt', '/decrypt']);
  });

  test('skips a connection whose tokens were refreshed while its envelope was being built', async () => {
    const user = await insertTestUser();
    const connectionId = await insertConnectionRow({ kilo_user_id: user.id });
    const refreshed = connectionPayload({
      access_token: 'access-token-refreshed',
      refresh_token: 'refresh-token-refreshed',
    });
    const refreshedColumns = sealOpenAiChatGptConnection(refreshed, {
      keyId: crypto.randomUUID(),
      dataKey: testDataKey,
    });
    interceptDataKeyRequests(async () => {
      await db
        .update(openai_chatgpt_connections)
        .set(refreshedColumns)
        .where(eq(openai_chatgpt_connections.id, connectionId));
    });

    const { connections } = await runBackfill();

    expect(summaryCounts(connections)).toMatchObject({
      migrated: 0,
      skippedConcurrentWrite: 1,
      remaining: 0,
    });
    const row = await readConnectionRow(connectionId);
    expect(row.encrypted_connection_envelope).toEqual(
      refreshedColumns.encrypted_connection_envelope
    );
    await expect(openOpenAiChatGptConnection(row)).resolves.toEqual(refreshed);
  });

  test('skips a connection rewritten by the previous deployment mid-run and retries it next run', async () => {
    const user = await insertTestUser();
    const connectionId = await insertConnectionRow({ kilo_user_id: user.id });
    const rotated = connectionPayload({ refresh_token: 'refresh-token-rotated' });
    let intercepted = false;
    interceptDataKeyRequests(async () => {
      if (intercepted) return;
      intercepted = true;
      await db
        .update(openai_chatgpt_connections)
        .set({ encrypted_connection: legacy(JSON.stringify(rotated)) })
        .where(eq(openai_chatgpt_connections.id, connectionId));
    });

    const first = await runBackfill();
    expect(summaryCounts(first.connections)).toMatchObject({
      skippedConcurrentWrite: 1,
      remaining: 1,
    });
    expect((await readConnectionRow(connectionId)).encrypted_connection_envelope).toBeNull();

    const second = await runBackfill();
    expect(summaryCounts(second.connections)).toMatchObject({ migrated: 1, remaining: 0 });
    await expect(
      openOpenAiChatGptConnection(await readConnectionRow(connectionId))
    ).resolves.toEqual(rotated);
  });

  test('never restores an inventory credential revoked while its envelope was being built', async () => {
    const id = await insertInventoryRow({ status: 'assigned' });
    interceptDataKeyRequests(async () => {
      await db
        .update(coding_plan_key_inventory)
        .set({
          status: 'revocation_pending',
          encrypted_api_key: null,
          encrypted_api_key_envelope: null,
        })
        .where(eq(coding_plan_key_inventory.id, id));
    });

    const { inventory } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({
      migrated: 0,
      skippedConcurrentWrite: 1,
      remaining: 0,
    });
    const row = await readInventoryRow(id);
    expect(row.encrypted_api_key).toBeNull();
    expect(row.encrypted_api_key_envelope).toBeNull();
  });

  test('never restores an inventory credential replaced while its envelope was being built', async () => {
    const id = await insertInventoryRow({ encrypted_api_key: legacy('sk-old') });
    const replacement = sealDualWrittenCredential('sk-new', testDataKey);
    interceptDataKeyRequests(async () => {
      await db
        .update(coding_plan_key_inventory)
        .set({
          encrypted_api_key: replacement.legacy,
          encrypted_api_key_envelope: replacement.envelope,
        })
        .where(eq(coding_plan_key_inventory.id, id));
    });

    const { inventory } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ skippedConcurrentWrite: 1, remaining: 0 });
    await expect(openCodingPlanInventoryCredential(await readInventoryRow(id))).resolves.toBe(
      'sk-new'
    );
  });

  test('removes an envelope left behind when the previous deployment cleared the credential', async () => {
    const sealed = sealDualWrittenCredential('sk-revoked', testDataKey);
    const id = await insertInventoryRow({
      encrypted_api_key: sealed.legacy,
      encrypted_api_key_envelope: sealed.envelope,
    });
    // A revocation by the previous deployment clears only the static-key column.
    await db
      .update(coding_plan_key_inventory)
      .set({ status: 'revocation_pending', encrypted_api_key: null })
      .where(eq(coding_plan_key_inventory.id, id));
    const before = await readInventoryRow(id);

    const { inventory } = await runBackfill();

    expect(inventory.clearedOrphanedEnvelopes).toBe(1);
    expect(inventory.remaining).toBe(0);
    const row = await readInventoryRow(id);
    expect(row.encrypted_api_key).toBeNull();
    expect(row.encrypted_api_key_envelope).toBeNull();
    expect(row.updated_at).toBe(before.updated_at);
    expect(kms.requests).toEqual([]);
  });

  test('counts and removes orphaned envelopes even when KMS is not configured', async () => {
    const sealed = sealDualWrittenCredential('sk-revoked', testDataKey);
    await insertInventoryRow({
      encrypted_api_key: null,
      encrypted_api_key_envelope: sealed.envelope,
    });
    delete process.env.BYOK_KMS_SERVICE_URL;

    const { inventory } = await runBackfill();

    expect(inventory.clearedOrphanedEnvelopes).toBe(1);
    expect(inventory.remaining).toBe(0);
  });

  test('does not migrate or count a member connection whose person was deleted', async () => {
    await insertConnectionRow({ kilo_user_id: null, created_by: 'deleted-user' });

    const { connections } = await runBackfill();

    expect(summaryCounts(connections)).toMatchObject({ migrated: 0, remaining: 0 });
    expect(kms.requests).toEqual([]);
  });

  test('counts KMS failures, leaves the rows untouched and migrates them once KMS recovers', async () => {
    const user = await insertTestUser();
    const inventoryId = await insertInventoryRow();
    await insertConnectionRow({ kilo_user_id: user.id });
    const fakeFetch = global.fetch;
    failKmsRequests('/data-key');

    const failed = await runBackfill();

    expect(summaryCounts(failed.inventory)).toMatchObject({
      migrated: 0,
      failed: { legacy_unreadable: 0, kms: 1, database: 0 },
      remaining: 1,
      errorName: null,
    });
    expect(summaryCounts(failed.connections)).toMatchObject({
      failed: { legacy_unreadable: 0, kms: 1, database: 0 },
      remaining: 1,
    });
    expect((await readInventoryRow(inventoryId)).encrypted_api_key_envelope).toBeNull();

    global.fetch = fakeFetch;
    const recovered = await runBackfill();
    expect(summaryCounts(recovered.inventory)).toMatchObject({ migrated: 1, remaining: 0 });
    expect(summaryCounts(recovered.connections)).toMatchObject({ migrated: 1, remaining: 0 });
  });

  test('logs a capped number of failed rows by category and error name, without identifiers', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await insertInventoryRow());
    failKmsRequests('/data-key');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { inventory } = await runBackfill();

      expect(inventory.failed.kms).toBe(7);
      const rowFailures = errorSpy.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('credential_kms_backfill.row_failed'));
      expect(rowFailures).toHaveLength(5);
      expect(JSON.parse(rowFailures[0])).toEqual({
        event: 'credential_kms_backfill.row_failed',
        store: 'coding_plan_inventory',
        category: 'kms',
        exception_name: 'Error',
        database_error_code: null,
      });
      const logged = JSON.stringify(errorSpy.mock.calls);
      for (const id of ids) expect(logged).not.toContain(id);
      expect(logged).not.toContain('sk-inventory-');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('counts a static-key copy that does not decrypt without asking KMS for a key', async () => {
    await insertInventoryRow({
      encrypted_api_key: encryptApiKey('sk-other-key', Buffer.alloc(32, 3).toString('base64')),
    });

    const { inventory } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({
      failed: { legacy_unreadable: 1, kms: 0, database: 0 },
      remaining: 1,
    });
    expect(inventory.reachedEnd).toBe(true);
    expect(kms.requests).toEqual([]);
  });

  test('reports an unconfigured KMS service once per store and still counts what remains', async () => {
    await insertInventoryRow();
    delete process.env.BYOK_KMS_SERVICE_URL;

    const { inventory, connections } = await runBackfill();

    expect(summaryCounts(inventory)).toMatchObject({ remaining: 1, errorName: 'Error' });
    expect(inventory.scanned).toBe(0);
    expect(summaryCounts(connections)).toMatchObject({ remaining: 0, errorName: 'Error' });
  });

  test('starts no row after the deadline and reports what remains', async () => {
    await insertInventoryRow();

    const { inventory } = await runBackfill({ deadlineAt: Date.now() - 1 });

    expect(inventory.scanned).toBe(0);
    expect(inventory.remaining).toBe(1);
    expect(inventory.reachedEnd).toBe(false);
  });

  test('starts at the given point of the keyspace and wraps around to the rows before it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await insertInventoryRow());
    const sorted = [...ids].sort();
    // Between the third and fourth ids in keyspace order.
    const startId = sorted[2];

    const [inventory] = await backfillCredentialKmsEnvelopes({
      deadlineAt: Date.now() + 60_000,
      batchSize: 2,
      startId,
    });

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 6, remaining: 0 });
    expect(inventory.reachedEnd).toBe(true);
    const order = kms.requests
      .filter(request => request.path === '/data-key')
      .map(request => request.body.key_id);
    // Rows after the start come first, then the pass wraps around to the start inclusive.
    expect(order).toEqual([...sorted.slice(3), ...sorted.slice(0, 3)]);
  });

  test('reaches healthy rows before failing rows that precede the start point', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await insertInventoryRow());
    const sorted = [...ids].sort();
    // The lowest ids always fail; a run starting just after them reaches the rest first.
    const failing = new Set(sorted.slice(0, 2));
    const fakeFetch = global.fetch;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isFakeByokKmsRequest(input) && String(input).endsWith('/data-key')) {
        const body = JSON.parse(String(init?.body)) as { key_id: string };
        if (failing.has(body.key_id)) return new Response('{}', { status: 403 });
      }
      return fakeFetch(input, init);
    };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const [inventory] = await backfillCredentialKmsEnvelopes({
      deadlineAt: Date.now() + 60_000,
      batchSize: 1,
      startId: sorted[1],
    }).finally(() => errorSpy.mockRestore());

    expect(inventory.migrated).toBe(2);
    expect(inventory.failed.kms).toBe(2);
    for (const id of sorted.slice(2)) {
      expect((await readInventoryRow(id)).encrypted_api_key_envelope).not.toBeNull();
    }
  });

  test('pages through more rows than one batch', async () => {
    for (let i = 0; i < 5; i++) await insertInventoryRow();

    const { inventory } = await runBackfill({ batchSize: 2 });

    expect(summaryCounts(inventory)).toMatchObject({ migrated: 5, remaining: 0 });
  });
});
