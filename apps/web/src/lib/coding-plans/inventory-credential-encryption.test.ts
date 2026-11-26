/* eslint-disable drizzle/enforce-delete-with-where */
import { CredentialKmsError } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { eq } from 'drizzle-orm';

import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { legacyCiphertextDigest } from '@kilocode/web-shared/lib/ai-gateway/byok/dual-write';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import {
  TEST_BYOK_DATA_KEY,
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  CodingPlanInventoryUploadError,
  queueAvailableInventoryForRevocation,
  reassignSubscriptionCredential,
  replaceInventoryCredential,
  subscribeToCodingPlan,
  uploadKeysToInventory,
} from '@/lib/coding-plans';
import { openCodingPlanInventoryCredential } from '@/lib/coding-plans/inventory-credential-encryption';
import {
  markCredentialManuallyRevoked,
  markCredentialManualRevocationFailed,
  replaceManualCredentialRevocation,
  requeueManualCredentialRevocation,
} from '@/lib/coding-plans/revocation';
import {
  dualWrittenInventoryColumns,
  insertInventoryRow,
  inventoryEnvelope,
  legacyInventoryCredential,
} from '@/tests/helpers/coding-plan-inventory.helper';

const ADMIN_USER_ID = 'admin-user-id';
const BYTEPLUS_PLAN_ID = 'byteplus-coding-plan-team-lite';
const BYTEPLUS_PROVIDER_ID = 'byteplus-coding';
const MINIMAX_PLAN_ID = 'minimax-token-plan-plus';
const COST_MICRODOLLARS = 20_000_000;

const kms = useFakeByokKms();

afterEach(async () => {
  await db.delete(coding_plan_terms);
  await db.delete(coding_plan_subscriptions);
  await db.delete(byok_api_keys);
  await db.delete(coding_plan_key_inventory);
  await db.delete(credit_transactions);
  await db.delete(kilocode_users);
});

function inventoryContext(inventoryId: string) {
  return {
    key_id: inventoryId,
    owner_type: 'organization',
    owner_id: KILO_ORGANIZATION_ID,
    provider_id: 'coding-plan-inventory',
  };
}

async function selectInventory(id: string) {
  const [row] = await db
    .select()
    .from(coding_plan_key_inventory)
    .where(eq(coding_plan_key_inventory.id, id));
  return row;
}

function expectClearedCredential(row: {
  encrypted_api_key: unknown;
  encrypted_api_key_envelope: unknown;
}) {
  expect(row.encrypted_api_key).toBeNull();
  expect(row.encrypted_api_key_envelope).toBeNull();
}

function expectSealedForRow(row: Awaited<ReturnType<typeof selectInventory>>, plaintext: string) {
  expect(row.encrypted_api_key).not.toBeNull();
  expect(row.encrypted_api_key_envelope).not.toBeNull();
  expect(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY)).toBe(plaintext);
  expect(decryptApiKey(row.encrypted_api_key_envelope!.encrypted_data, TEST_BYOK_DATA_KEY)).toBe(
    plaintext
  );
  expect(row.encrypted_api_key_envelope!.legacy_digest).toBe(
    legacyCiphertextDigest(row.encrypted_api_key!)
  );
  const serialized = JSON.stringify([row.encrypted_api_key, row.encrypted_api_key_envelope]);
  expect(serialized).not.toContain(plaintext);
}

async function insertSubscribableUser() {
  return insertTestUser({ total_microdollars_acquired: COST_MICRODOLLARS, microdollars_used: 0 });
}

async function installedByokPlaintext(userId: string) {
  const [byok] = await db
    .select()
    .from(byok_api_keys)
    .where(eq(byok_api_keys.kilo_user_id, userId));
  return decryptApiKey(byok.encrypted_api_key_envelope!.encrypted_data, TEST_BYOK_DATA_KEY);
}

describe('uploadKeysToInventory', () => {
  const validateCredential = async () => ({ valid: true });

  it('writes the static-key copy and a KMS envelope bound to each inserted row', async () => {
    await uploadKeysToInventory(
      'minimax',
      MINIMAX_PLAN_ID,
      ['upload-secret-1::upstream-1', 'upload-secret-2::upstream-2'],
      ADMIN_USER_ID,
      { validateCredential }
    );

    const rows = await db.select().from(coding_plan_key_inventory);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const plaintext =
        row.upstream_plan_id === 'upstream-1' ? 'upload-secret-1' : 'upload-secret-2';
      expectSealedForRow(row, plaintext);
    }
    const dataKeyRequests = kms.requests.filter(request => request.path === '/data-key');
    expect(dataKeyRequests).toHaveLength(2);
    expect(dataKeyRequests.map(request => request.body)).toEqual(
      expect.arrayContaining(
        rows.map(row => ({ ...inventoryContext(row.id), actor_user_id: ADMIN_USER_ID }))
      )
    );
    expect(dataKeyRequests.map(request => request.body.key_id).sort()).toEqual(
      rows.map(row => row.id).sort()
    );
  });

  it('fails without inserting anything when the KMS data key cannot be created', async () => {
    kms.fail('/data-key', 403);

    await expect(
      uploadKeysToInventory(
        'minimax',
        MINIMAX_PLAN_ID,
        ['upload-secret-kms-down::upstream-kms-down'],
        ADMIN_USER_ID,
        { validateCredential }
      )
    ).rejects.toThrow(CodingPlanInventoryUploadError);

    expect(await db.select().from(coding_plan_key_inventory)).toHaveLength(0);
  });
});

describe('openCodingPlanInventoryCredential', () => {
  it('prefers the current envelope over the static-key copy', async () => {
    const id = crypto.randomUUID();
    const columns = dualWrittenInventoryColumns('legacy-value', 'envelope-value');

    await expect(openCodingPlanInventoryCredential({ id, ...columns })).resolves.toBe(
      'envelope-value'
    );

    const decryptRequests = kms.requests.filter(request => request.path === '/decrypt');
    expect(decryptRequests).toHaveLength(1);
    expect(decryptRequests[0].body).toMatchObject(inventoryContext(id));
  });

  it('uses the static-key copy when the row has no envelope', async () => {
    const result = await openCodingPlanInventoryCredential({
      id: crypto.randomUUID(),
      encrypted_api_key: legacyInventoryCredential('legacy-only-value'),
      encrypted_api_key_envelope: null,
    });

    expect(result).toBe('legacy-only-value');
    expect(kms.requests).toHaveLength(0);
  });

  it('ignores a stale envelope and uses the static-key copy', async () => {
    const result = await openCodingPlanInventoryCredential({
      id: crypto.randomUUID(),
      encrypted_api_key: legacyInventoryCredential('rewritten-by-rollback'),
      encrypted_api_key_envelope: inventoryEnvelope('stale-envelope-value', 'not-the-digest'),
    });

    expect(result).toBe('rewritten-by-rollback');
    expect(kms.requests).toHaveLength(0);
  });

  it('reads a cleared static-key column as no credential even if an envelope remains', async () => {
    const result = await openCodingPlanInventoryCredential({
      id: crypto.randomUUID(),
      encrypted_api_key: null,
      encrypted_api_key_envelope:
        dualWrittenInventoryColumns('revoked-value').encrypted_api_key_envelope,
    });

    expect(result).toBeNull();
    expect(kms.requests).toHaveLength(0);
  });

  it('throws instead of using the static-key copy when the KMS decrypt fails', async () => {
    kms.fail('/decrypt', 403);

    await expect(
      openCodingPlanInventoryCredential({
        id: crypto.randomUUID(),
        ...dualWrittenInventoryColumns('legacy-value', 'envelope-value'),
      })
    ).rejects.toBeInstanceOf(CredentialKmsError);
  });

  it("decrypts an envelope copied from another row with the reading row's context", async () => {
    const sourceId = crypto.randomUUID();
    const readingId = crypto.randomUUID();
    const columns = dualWrittenInventoryColumns('copied-value');

    await openCodingPlanInventoryCredential({ id: readingId, ...columns });

    const decryptRequests = kms.requests.filter(request => request.path === '/decrypt');
    expect(decryptRequests).toHaveLength(1);
    expect(decryptRequests[0].body.key_id).toBe(readingId);
    expect(decryptRequests[0].body.key_id).not.toBe(sourceId);
  });
});

describe('claiming an inventory credential', () => {
  it('subscribe installs the credential from a current envelope', async () => {
    const user = await insertSubscribableUser();
    const inventory = await insertInventoryRow({
      ...dualWrittenInventoryColumns('legacy-decoy', 'envelope-secret'),
    });
    kms.requests.length = 0;

    await subscribeToCodingPlan(user.id, BYTEPLUS_PLAN_ID, 'envelope-subscribe');

    expect(await installedByokPlaintext(user.id)).toBe('envelope-secret');
    expect(
      kms.requests.filter(request => request.path === '/decrypt').map(request => request.body)
    ).toEqual([expect.objectContaining(inventoryContext(inventory.id))]);
    expect((await selectInventory(inventory.id)).status).toBe('assigned');
  });

  it('subscribe installs the credential from a legacy-only row', async () => {
    const user = await insertSubscribableUser();
    const inventory = await insertInventoryRow({
      encrypted_api_key: legacyInventoryCredential('legacy-only-secret'),
    });
    kms.requests.length = 0;

    await subscribeToCodingPlan(user.id, BYTEPLUS_PLAN_ID, 'legacy-subscribe');

    expect(await installedByokPlaintext(user.id)).toBe('legacy-only-secret');
    expect(kms.requests.filter(request => request.path === '/decrypt')).toHaveLength(0);
    expect((await selectInventory(inventory.id)).status).toBe('assigned');
  });

  it('subscribe opens another row under the lock when its prepared candidate was claimed', async () => {
    const user = await insertSubscribableUser();
    await insertInventoryRow({ ...dualWrittenInventoryColumns('first-secret') });
    await insertInventoryRow({ ...dualWrittenInventoryColumns('second-secret') });
    const fakeFetch = global.fetch;
    let candidateId: string | undefined;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (candidateId === undefined && String(input).endsWith('/decrypt')) {
        // A concurrent purchase claims the candidate while it is being decrypted.
        candidateId = String((JSON.parse(String(init?.body)) as { key_id: string }).key_id);
        await db
          .update(coding_plan_key_inventory)
          .set({ status: 'assigned' })
          .where(eq(coding_plan_key_inventory.id, candidateId));
      }
      return fakeFetch(input, init);
    };
    kms.requests.length = 0;

    await subscribeToCodingPlan(user.id, BYTEPLUS_PLAN_ID, 'contended-subscribe');

    const decryptedIds = kms.requests
      .filter(request => request.path === '/decrypt')
      .map(request => request.body.key_id);
    expect(decryptedIds).toHaveLength(2);
    expect(decryptedIds[0]).toBe(candidateId);
    expect(decryptedIds[1]).not.toBe(candidateId);
    const claimed = await selectInventory(String(decryptedIds[1]));
    expect(claimed.status).toBe('assigned');
    expect(await installedByokPlaintext(user.id)).toBe(
      await openCodingPlanInventoryCredential(claimed)
    );
  });

  it('subscribe skips a row whose envelope KMS refuses and installs healthy stock', async () => {
    const user = await insertSubscribableUser();
    const refused = await insertInventoryRow({
      ...dualWrittenInventoryColumns('refused-legacy', 'refused-envelope'),
    });
    await insertInventoryRow({ ...dualWrittenInventoryColumns('healthy-secret') });
    kms.refuseDecryptFor(refused.id);

    await subscribeToCodingPlan(user.id, BYTEPLUS_PLAN_ID, 'refused-row-subscribe');

    // The refused row's static-key copy is never used in its place.
    expect(await installedByokPlaintext(user.id)).toBe('healthy-secret');
    expect((await selectInventory(refused.id)).status).toBe('available');
  });

  it('reassign skips a row whose envelope KMS refuses and installs healthy stock', async () => {
    const { user, subscription } = await insertAssignedSubscription(
      dualWrittenInventoryColumns('previous-secret')
    );
    const refused = await insertInventoryRow({
      ...dualWrittenInventoryColumns('refused-legacy', 'refused-envelope'),
    });
    const healthy = await insertInventoryRow({ ...dualWrittenInventoryColumns('healthy-secret') });
    kms.refuseDecryptFor(refused.id);

    await expect(reassignSubscriptionCredential(subscription.id, ADMIN_USER_ID)).resolves.toEqual({
      inventoryKeyId: healthy.id,
    });

    expect(await installedByokPlaintext(user.id)).toBe('healthy-secret');
    expect((await selectInventory(refused.id)).status).toBe('available');
  });

  it('subscribe does not claim a row whose credential was cleared', async () => {
    const user = await insertSubscribableUser();
    await insertInventoryRow({
      encrypted_api_key: null,
      encrypted_api_key_envelope: dualWrittenInventoryColumns('cleared').encrypted_api_key_envelope,
    });

    await expect(
      subscribeToCodingPlan(user.id, BYTEPLUS_PLAN_ID, 'cleared-subscribe')
    ).rejects.toThrow('No managed credential is available');
  });

  async function insertAssignedSubscription(
    previousColumns: Pick<
      typeof coding_plan_key_inventory.$inferInsert,
      'encrypted_api_key' | 'encrypted_api_key_envelope'
    >
  ) {
    const user = await insertTestUser();
    const previous = await insertInventoryRow({
      ...previousColumns,
      status: 'assigned',
      assigned_to_user_id: user.id,
    });
    const [byok] = await db
      .insert(byok_api_keys)
      .values({
        kilo_user_id: user.id,
        provider_id: BYTEPLUS_PROVIDER_ID,
        encrypted_api_key_envelope: testByokEnvelope('previous-secret'),
        management_source: 'coding_plan',
        created_by: user.id,
      })
      .returning();
    const [subscription] = await db
      .insert(coding_plan_subscriptions)
      .values({
        user_id: user.id,
        plan_id: BYTEPLUS_PLAN_ID,
        provider_id: BYTEPLUS_PROVIDER_ID,
        key_inventory_id: previous.id,
        installed_byok_key_id: byok.id,
        status: 'active',
        cost_microdollars: COST_MICRODOLLARS,
        billing_period_days: 30,
        current_period_start: '2026-06-20T12:00:00.000Z',
        current_period_end: '2026-07-20T12:00:00.000Z',
        credit_renewal_at: '2026-07-20T12:00:00.000Z',
      })
      .returning();
    return { user, previous, subscription };
  }

  it('reassign installs the credential from a current envelope and clears the previous row', async () => {
    const { user, previous, subscription } = await insertAssignedSubscription(
      dualWrittenInventoryColumns('previous-secret')
    );
    const pooled = await insertInventoryRow({
      ...dualWrittenInventoryColumns('legacy-decoy', 'pooled-envelope-secret'),
    });
    kms.requests.length = 0;

    const result = await reassignSubscriptionCredential(subscription.id, ADMIN_USER_ID);

    expect(result.inventoryKeyId).toBe(pooled.id);
    expect(await installedByokPlaintext(user.id)).toBe('pooled-envelope-secret');
    expect(
      kms.requests.filter(request => request.path === '/decrypt').map(request => request.body)
    ).toEqual([expect.objectContaining(inventoryContext(pooled.id))]);
    const previousAfter = await selectInventory(previous.id);
    expect(previousAfter.status).toBe('revocation_pending');
    expectClearedCredential(previousAfter);
    expect((await selectInventory(pooled.id)).status).toBe('assigned');
  });

  it('reassign installs the credential from a legacy-only row', async () => {
    const { user, previous, subscription } = await insertAssignedSubscription({
      encrypted_api_key: legacyInventoryCredential('previous-secret'),
      encrypted_api_key_envelope: null,
    });
    await insertInventoryRow({
      encrypted_api_key: legacyInventoryCredential('pooled-legacy-secret'),
    });
    kms.requests.length = 0;

    await reassignSubscriptionCredential(subscription.id, ADMIN_USER_ID);

    expect(await installedByokPlaintext(user.id)).toBe('pooled-legacy-secret');
    expect(kms.requests.filter(request => request.path === '/decrypt')).toHaveLength(0);
    expectClearedCredential(await selectInventory(previous.id));
  });
});

describe('replacing an inventory credential', () => {
  it('replaceInventoryCredential writes both forms bound to the row id', async () => {
    const row = await insertInventoryRow({
      plan_id: MINIMAX_PLAN_ID,
      provider_id: 'minimax',
      upstream_usage_id: null,
      ...dualWrittenInventoryColumns('old-secret'),
    });

    await replaceInventoryCredential(row.id, ' replacement-secret ', ADMIN_USER_ID, {
      validateCredential: async () => ({ valid: true }),
    });

    expectSealedForRow(await selectInventory(row.id), 'replacement-secret');
    expect(kms.requests.filter(request => request.path === '/data-key')).toEqual([
      {
        path: '/data-key',
        body: { ...inventoryContext(row.id), actor_user_id: ADMIN_USER_ID },
      },
    ]);
  });

  it.each(['replaceInventoryCredential', 'replaceManualCredentialRevocation'] as const)(
    '%s binds an uppercase inventory id to the lowercase id a later read uses',
    async replacement => {
      const row = await insertInventoryRow(
        replacement === 'replaceInventoryCredential'
          ? {
              plan_id: MINIMAX_PLAN_ID,
              provider_id: 'minimax',
              upstream_usage_id: null,
              ...dualWrittenInventoryColumns('old-secret'),
            }
          : { status: 'revocation_pending' }
      );
      const uppercaseId = row.id.toUpperCase();

      if (replacement === 'replaceInventoryCredential') {
        await replaceInventoryCredential(uppercaseId, 'uppercase-replacement', ADMIN_USER_ID, {
          validateCredential: async () => ({ valid: true }),
        });
      } else {
        await replaceManualCredentialRevocation(
          uppercaseId,
          'uppercase-replacement',
          ADMIN_USER_ID,
          { validateCredential: async () => ({ valid: true, upstreamUsageId: 'seat-uppercase' }) }
        );
      }

      const stored = await selectInventory(row.id);
      await expect(openCodingPlanInventoryCredential(stored)).resolves.toBe(
        'uppercase-replacement'
      );
      const [dataKeyRequest] = kms.requests.filter(request => request.path === '/data-key');
      const decryptRequests = kms.requests.filter(request => request.path === '/decrypt');
      // The fake KMS service does not check bindings; the real one refuses a context that
      // differs from the one the data key was created for, so the request bodies must agree.
      expect(dataKeyRequest.body.key_id).toBe(row.id);
      expect(decryptRequests.at(-1)?.body).toMatchObject(inventoryContext(row.id));
    }
  );

  it('replaceInventoryCredential replaces a stale envelope', async () => {
    const row = await insertInventoryRow({
      plan_id: MINIMAX_PLAN_ID,
      provider_id: 'minimax',
      upstream_usage_id: null,
      encrypted_api_key: legacyInventoryCredential('rolled-back-secret'),
      encrypted_api_key_envelope: inventoryEnvelope('stale-secret', 'not-the-digest'),
    });

    await replaceInventoryCredential(row.id, 'fresh-secret', ADMIN_USER_ID, {
      validateCredential: async () => ({ valid: true }),
    });

    const after = await selectInventory(row.id);
    expectSealedForRow(after, 'fresh-secret');
    await expect(openCodingPlanInventoryCredential(after)).resolves.toBe('fresh-secret');
  });

  it('replaceManualCredentialRevocation writes both forms bound to the row id', async () => {
    const row = await insertInventoryRow({ status: 'revocation_pending' });

    await replaceManualCredentialRevocation(row.id, ' manual-replacement ', ADMIN_USER_ID, {
      validateCredential: async () => ({ valid: true, upstreamUsageId: 'seat-manual-replacement' }),
    });

    const after = await selectInventory(row.id);
    expect(after.status).toBe('available');
    expectSealedForRow(after, 'manual-replacement');
    expect(kms.requests.filter(request => request.path === '/data-key')).toEqual([
      {
        path: '/data-key',
        body: { ...inventoryContext(row.id), actor_user_id: ADMIN_USER_ID },
      },
    ]);
  });

  it('replaceManualCredentialRevocation leaves the row untouched when the data key fails', async () => {
    const row = await insertInventoryRow({ status: 'revocation_pending' });
    kms.fail('/data-key', 403);

    await expect(
      replaceManualCredentialRevocation(row.id, 'manual-replacement', ADMIN_USER_ID, {
        validateCredential: async () => ({ valid: true, upstreamUsageId: 'seat-manual' }),
      })
    ).rejects.toThrow('Unable to create an encryption key');

    const after = await selectInventory(row.id);
    expect(after.status).toBe('revocation_pending');
    expectClearedCredential(after);
  });
});

describe('clearing an inventory credential', () => {
  it('markCredentialManuallyRevoked clears both forms', async () => {
    const row = await insertInventoryRow({
      status: 'revocation_pending',
      ...dualWrittenInventoryColumns('revoke-me'),
    });

    await markCredentialManuallyRevoked(row.id);

    const after = await selectInventory(row.id);
    expect(after.status).toBe('revoked');
    expectClearedCredential(after);
  });

  it('markCredentialManualRevocationFailed clears both forms', async () => {
    const row = await insertInventoryRow({
      status: 'revocation_pending',
      ...dualWrittenInventoryColumns('fail-me'),
    });

    await markCredentialManualRevocationFailed(row.id, 'upstream said no');

    const after = await selectInventory(row.id);
    expect(after.status).toBe('revocation_failed');
    expectClearedCredential(after);
  });

  it('requeueManualCredentialRevocation clears both forms', async () => {
    const row = await insertInventoryRow({
      status: 'revocation_failed',
      ...dualWrittenInventoryColumns('requeue-me'),
    });

    await requeueManualCredentialRevocation(row.id);

    const after = await selectInventory(row.id);
    expect(after.status).toBe('revocation_pending');
    expectClearedCredential(after);
  });

  it('queueAvailableInventoryForRevocation clears both forms', async () => {
    const row = await insertInventoryRow({
      status: 'available',
      ...dualWrittenInventoryColumns('reduce-me'),
    });

    const result = await queueAvailableInventoryForRevocation(BYTEPLUS_PLAN_ID, 1, ADMIN_USER_ID);

    expect(result.queued.map(queued => queued.id)).toEqual([row.id]);
    const after = await selectInventory(row.id);
    expect(after.status).toBe('revocation_pending');
    expectClearedCredential(after);
  });
});
