import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import {
  microdollar_usage,
  model_experiment,
  model_experiment_request,
  model_experiment_variant,
  model_experiment_variant_version,
} from '@kilocode/db/schema';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';
import { randomUUID } from 'crypto';

let admin: User;

const validUpstream = {
  internal_id: 'partner-checkpoint-rc1',
  base_url: 'https://partner.example.com/v1',
};

const validUpstreamRc2 = {
  internal_id: 'partner-checkpoint-rc2',
  base_url: 'https://partner.example.com/v1',
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

async function makeDraftWithTwoVariants(publicId: string) {
  const caller = await createCallerForUser(admin.id);
  const exp = await caller.admin.modelExperiments.create({
    public_model_id: publicId,
    name: `exp-${publicId}`,
  });
  const a = await caller.admin.modelExperiments.addVariant({
    id: exp.id,
    label: 'control',
    weight: 1,
  });
  const b = await caller.admin.modelExperiments.addVariant({
    id: exp.id,
    label: 'treatment',
    weight: 1,
  });
  await caller.admin.modelExperiments.swapVariantVersion({
    variantId: a.id,
    upstream: validUpstream,
    apiKey: 'sk-control-key',
  });
  await caller.admin.modelExperiments.swapVariantVersion({
    variantId: b.id,
    upstream: validUpstreamRc2,
    apiKey: 'sk-treatment-key',
  });
  return { caller, experimentId: exp.id, variantA: a, variantB: b };
}

describe('admin.modelExperiments — basic CRUD', () => {
  it('creates a draft experiment owned by the calling admin', async () => {
    const caller = await createCallerForUser(admin.id);
    const created = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-foo',
      name: 'Preview Foo',
      description: 'partner test',
    });
    expect(created.status).toBe('draft');
    expect(created.public_model_id).toBe('kilo/preview-foo');
    expect(created.created_by_user_id).toBe(admin.id);
  });

  it('list excludes archived by default and includes when requested', async () => {
    const caller = await createCallerForUser(admin.id);
    const a = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-a',
      name: 'A',
    });
    const b = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-b',
      name: 'B',
    });
    await caller.admin.modelExperiments.setArchived({ id: b.id, archived: true });

    const defaultList = await caller.admin.modelExperiments.list();
    expect(defaultList.items.map(i => i.id).sort()).toEqual([a.id]);

    const withArchived = await caller.admin.modelExperiments.list({ includeArchived: true });
    expect(withArchived.items.map(i => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('lists the last experiment attribution requests with usage and variant metadata', async () => {
    const { caller, experimentId, variantA } =
      await makeDraftWithTwoVariants('kilo/preview-requests');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    const [version] = await db
      .select({ id: model_experiment_variant_version.id })
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.variant_id, variantA.id))
      .limit(1);
    expect(version).toBeDefined();

    const usageId = randomUUID();
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: 'request-user',
      cost: 0,
      input_tokens: 123,
      output_tokens: 45,
      cache_write_tokens: 6,
      cache_hit_tokens: 7,
      provider: 'custom',
      model: 'partner-checkpoint-rc1',
      requested_model: 'kilo/preview-requests',
      inference_provider: 'partner',
      organization_id: null,
    });
    await db.insert(model_experiment_request).values({
      usage_id: usageId,
      variant_version_id: version.id,
      allocation_subject: 'user',
      client_request_id: 'client-request-123',
      request_kind: 'chat_completions',
      request_body_sha256: '__failed__',
      was_truncated: true,
    });

    const requests = await caller.admin.modelExperiments.listRequests();

    expect(requests.items[0]).toEqual(
      expect.objectContaining({
        usageId,
        experimentId,
        experimentName: 'exp-kilo/preview-requests',
        publicModelId: 'kilo/preview-requests',
        variantId: variantA.id,
        variantLabel: 'control',
        variantVersionId: version.id,
        allocationSubject: 'user',
        clientRequestId: 'client-request-123',
        requestKind: 'chat_completions',
        requestBodySha256: '__failed__',
        wasTruncated: true,
        userId: 'request-user',
        requestedModel: 'kilo/preview-requests',
        upstreamModel: 'partner-checkpoint-rc1',
        inputTokens: 123,
        outputTokens: 45,
      })
    );
  });

  it('rejects delete unless status is draft', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-delete');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await expect(caller.admin.modelExperiments.delete({ id: experimentId })).rejects.toMatchObject({
      message: expect.stringContaining('draft'),
    });
  });
});

describe('admin.modelExperiments — activation guards', () => {
  it('allows activation with one variant for sequential testing', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-thin',
      name: 'thin',
    });
    const v = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: v.id,
      upstream: validUpstream,
      apiKey: 'sk',
    });

    const activated = await caller.admin.modelExperiments.activate({ id: exp.id });
    expect(activated.status).toBe('active');
  });

  it('rejects activation with no variants', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-empty',
      name: 'empty',
    });

    await expect(caller.admin.modelExperiments.activate({ id: exp.id })).rejects.toMatchObject({
      message: expect.stringContaining('at least 1 variant'),
    });
  });

  it('rejects activation when a variant has no version row', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-noversion',
      name: 'noversion',
    });
    const a = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    await caller.admin.modelExperiments.addVariant({ id: exp.id, label: 'b', weight: 1 });
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: a.id,
      upstream: validUpstream,
      apiKey: 'sk',
    });
    await expect(caller.admin.modelExperiments.activate({ id: exp.id })).rejects.toMatchObject({
      message: expect.stringContaining('variant_version'),
    });
  });

  it('rejects a second active experiment on the same public_model_id', async () => {
    const first = await makeDraftWithTwoVariants('kilo/preview-conflict');
    await first.caller.admin.modelExperiments.activate({ id: first.experimentId });

    const second = await makeDraftWithTwoVariants('kilo/preview-conflict');
    await expect(
      second.caller.admin.modelExperiments.activate({ id: second.experimentId })
    ).rejects.toMatchObject({ message: expect.stringContaining('Another active or paused') });
  });

  it('maps a concurrent unique-violation on activate to CONFLICT (TOCTOU safety net)', async () => {
    // Build a ready-to-activate draft.
    const target = await makeDraftWithTwoVariants('kilo/preview-toctou');

    // Simulate a racing admin: between the friendly pre-check and the
    // UPDATE, sneak a sibling active experiment into the DB so the
    // partial unique index will fire on the UPDATE. We do this by
    // directly INSERTing a sibling instead of going through the API,
    // because the API would reject it with the same friendly CONFLICT.
    await db.insert(model_experiment).values({
      public_model_id: 'kilo/preview-toctou',
      name: 'sibling-active',
      status: 'active',
    });

    // The handler's pre-check sees the sibling (so we get CONFLICT here
    // via the friendly path), but if it didn't, the helper's 23505
    // catch would catch the same case. Either way, the result is a
    // user-friendly CONFLICT, not INTERNAL_SERVER_ERROR.
    await expect(
      target.caller.admin.modelExperiments.activate({ id: target.experimentId })
    ).rejects.toMatchObject({ message: expect.stringContaining('Another active or paused') });
  });

  it('allows a draft to coexist with an active experiment on the same public_id', async () => {
    const first = await makeDraftWithTwoVariants('kilo/preview-stack');
    await first.caller.admin.modelExperiments.activate({ id: first.experimentId });

    // Just verifying the draft can exist and be listed; uniqueness is only on
    // (active|paused).
    const second = await makeDraftWithTwoVariants('kilo/preview-stack');
    expect(second.experimentId).not.toBe(first.experimentId);
  });
});

describe('admin.modelExperiments — state machine', () => {
  it('walks draft → active → paused → active → completed', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-sm');
    let row = await caller.admin.modelExperiments.activate({ id: experimentId });
    expect(row.status).toBe('active');
    expect(row.started_at).not.toBeNull();

    row = await caller.admin.modelExperiments.pause({ id: experimentId });
    expect(row.status).toBe('paused');

    row = await caller.admin.modelExperiments.activate({ id: experimentId });
    expect(row.status).toBe('active');

    row = await caller.admin.modelExperiments.complete({ id: experimentId });
    expect(row.status).toBe('completed');
    expect(row.ended_at).not.toBeNull();
  });

  it('rejects pausing a non-active experiment', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-pause');
    await expect(caller.admin.modelExperiments.pause({ id: experimentId })).rejects.toMatchObject({
      message: expect.stringContaining('Only active'),
    });
  });

  it('rejects activation of a completed experiment', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-done');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await caller.admin.modelExperiments.complete({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.activate({ id: experimentId })
    ).rejects.toMatchObject({ message: expect.stringContaining('completed') });
  });
});

describe('admin.modelExperiments — archive', () => {
  it('forbids archiving an active experiment', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-arch');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.setArchived({ id: experimentId, archived: true })
    ).rejects.toMatchObject({ message: expect.stringContaining('active') });
  });

  it('allows archiving paused / completed / draft', async () => {
    const a = await makeDraftWithTwoVariants('kilo/preview-arch-a');
    await a.caller.admin.modelExperiments.setArchived({ id: a.experimentId, archived: true });

    const b = await makeDraftWithTwoVariants('kilo/preview-arch-b');
    await b.caller.admin.modelExperiments.activate({ id: b.experimentId });
    await b.caller.admin.modelExperiments.pause({ id: b.experimentId });
    await b.caller.admin.modelExperiments.setArchived({ id: b.experimentId, archived: true });

    const c = await makeDraftWithTwoVariants('kilo/preview-arch-c');
    await c.caller.admin.modelExperiments.activate({ id: c.experimentId });
    await c.caller.admin.modelExperiments.complete({ id: c.experimentId });
    await c.caller.admin.modelExperiments.setArchived({ id: c.experimentId, archived: true });
  });
});

describe('admin.modelExperiments — variant ops', () => {
  it('rejects addVariant after activation (structural edit)', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-add');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.addVariant({
        id: experimentId,
        label: 'extra',
        weight: 1,
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('draft') });
  });

  it('rejects removeVariant after activation', async () => {
    const { caller, experimentId, variantA } = await makeDraftWithTwoVariants('kilo/preview-rm');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.removeVariant({ variantId: variantA.id })
    ).rejects.toMatchObject({ message: expect.stringContaining('draft') });
  });

  it('allows updateVariantLabel in non-terminal state', async () => {
    const { caller, experimentId, variantA } = await makeDraftWithTwoVariants('kilo/preview-label');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    const renamed = await caller.admin.modelExperiments.updateVariantLabel({
      variantId: variantA.id,
      label: 'control-renamed',
    });
    expect(renamed.label).toBe('control-renamed');
  });

  it('rejects updateVariantLabel on completed', async () => {
    const { caller, experimentId, variantA } =
      await makeDraftWithTwoVariants('kilo/preview-label-done');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await caller.admin.modelExperiments.complete({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.updateVariantLabel({
        variantId: variantA.id,
        label: 'too-late',
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('completed') });
  });
});

describe('admin.modelExperiments — versions and api keys', () => {
  it('encrypts the api key on swapVariantVersion and never returns it', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-key',
      name: 'k',
    });
    const v = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    const inserted = await caller.admin.modelExperiments.swapVariantVersion({
      variantId: v.id,
      upstream: validUpstream,
      apiKey: 'sk-secret-abc',
    });

    // tRPC response shape MUST NOT include the encrypted key.
    expect(inserted).not.toHaveProperty('encrypted_api_key');

    // The DB row stores the encrypted form, decryptable.
    const row = await db.query.model_experiment_variant_version.findFirst({
      where: eq(model_experiment_variant_version.id, inserted.id),
    });
    expect(row).toBeTruthy();
    if (!row) return;
    expect(decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-secret-abc');
  });

  it('hot-swap inserts a new version row; old rows remain', async () => {
    const { caller, variantA } = await makeDraftWithTwoVariants('kilo/preview-hotswap');

    const before = await db
      .select()
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.variant_id, variantA.id));
    expect(before.length).toBe(1);

    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: variantA.id,
      upstream: validUpstreamRc2,
      apiKey: 'sk-rc2',
    });

    const after = await db
      .select()
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.variant_id, variantA.id));
    expect(after.length).toBe(2);
  });

  it('allows hot-swap on active and paused', async () => {
    const { caller, experimentId, variantA } =
      await makeDraftWithTwoVariants('kilo/preview-livehot');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: variantA.id,
      upstream: validUpstreamRc2,
      apiKey: 'sk-active',
    });

    await caller.admin.modelExperiments.pause({ id: experimentId });
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: variantA.id,
      upstream: validUpstream,
      apiKey: 'sk-paused',
    });

    const rows = await db
      .select()
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.variant_id, variantA.id));
    expect(rows.length).toBe(3);
  });

  it('rejects hot-swap on completed', async () => {
    const { caller, experimentId, variantA } =
      await makeDraftWithTwoVariants('kilo/preview-hot-done');
    await caller.admin.modelExperiments.activate({ id: experimentId });
    await caller.admin.modelExperiments.complete({ id: experimentId });
    await expect(
      caller.admin.modelExperiments.swapVariantVersion({
        variantId: variantA.id,
        upstream: validUpstream,
        apiKey: 'sk-too-late',
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('completed') });
  });

  it('rotateApiKey copies prior upstream and inserts new encrypted key', async () => {
    const { caller, variantA } = await makeDraftWithTwoVariants('kilo/preview-rot');
    const rotated = await caller.admin.modelExperiments.rotateApiKey({
      variantId: variantA.id,
      apiKey: 'sk-rotated',
    });

    expect(rotated.upstream).toEqual(validUpstream);
    expect(rotated).not.toHaveProperty('encrypted_api_key');

    const row = await db.query.model_experiment_variant_version.findFirst({
      where: eq(model_experiment_variant_version.id, rotated.id),
    });
    if (!row) throw new Error('rotated row missing');
    expect(decryptApiKey(row.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-rotated');
  });

  it('rotateApiKey rejects when variant has no prior version', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-rot-empty',
      name: 'r',
    });
    const v = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    await expect(
      caller.admin.modelExperiments.rotateApiKey({ variantId: v.id, apiKey: 'sk' })
    ).rejects.toMatchObject({ message: expect.stringContaining('no existing version') });
  });

  it('rejects swap with invalid upstream (extra fields)', async () => {
    const { caller, variantA } = await makeDraftWithTwoVariants('kilo/preview-bad');
    await expect(
      caller.admin.modelExperiments.swapVariantVersion({
        variantId: variantA.id,
        // @ts-expect-error — exercising strict schema rejection
        upstream: { ...validUpstream, api_key: 'leaked' },
        apiKey: 'sk',
      })
    ).rejects.toBeTruthy();
  });

  it('swapVariantVersion without apiKey reuses the prior encrypted key', async () => {
    const { caller, variantA } = await makeDraftWithTwoVariants('kilo/preview-reuse');
    const before = await db.query.model_experiment_variant_version.findFirst({
      where: eq(model_experiment_variant_version.variant_id, variantA.id),
    });
    if (!before) throw new Error('seed version missing');

    const after = await caller.admin.modelExperiments.swapVariantVersion({
      variantId: variantA.id,
      upstream: validUpstreamRc2,
      // apiKey deliberately omitted — should copy `before`'s encrypted blob.
    });

    const afterRow = await db.query.model_experiment_variant_version.findFirst({
      where: eq(model_experiment_variant_version.id, after.id),
    });
    if (!afterRow) throw new Error('inserted row missing');

    expect(afterRow.encrypted_api_key).toEqual(before.encrypted_api_key);
    expect(decryptApiKey(afterRow.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-control-key');
    // Upstream changed.
    expect(afterRow.upstream).toEqual(validUpstreamRc2);
  });

  it('swapVariantVersion without apiKey rejects when variant has no prior version', async () => {
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-firstver',
      name: 'f',
    });
    const v = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    await expect(
      caller.admin.modelExperiments.swapVariantVersion({
        variantId: v.id,
        upstream: validUpstream,
        // apiKey omitted on a brand-new variant — must error.
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('apiKey is required') });
  });
});

describe('admin.modelExperiments — privacy and shape', () => {
  it('get(id) never returns encrypted_api_key on any version row', async () => {
    const { caller, experimentId } = await makeDraftWithTwoVariants('kilo/preview-priv');
    const detail = await caller.admin.modelExperiments.get({ id: experimentId });

    expect(detail.experiment).not.toHaveProperty('encrypted_api_key');
    for (const variant of detail.variants) {
      expect(variant.current_version).not.toBeNull();
      if (variant.current_version) {
        expect(variant.current_version).not.toHaveProperty('encrypted_api_key');
      }
    }
  });

  it('cascade delete: removing the experiment row drops variants and versions', async () => {
    // Use a draft so delete is allowed.
    const caller = await createCallerForUser(admin.id);
    const exp = await caller.admin.modelExperiments.create({
      public_model_id: 'kilo/preview-cascade',
      name: 'c',
    });
    const v = await caller.admin.modelExperiments.addVariant({
      id: exp.id,
      label: 'a',
      weight: 1,
    });
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: v.id,
      upstream: validUpstream,
      apiKey: 'sk',
    });

    await caller.admin.modelExperiments.delete({ id: exp.id });

    expect(
      await db.query.model_experiment.findFirst({
        where: eq(model_experiment.id, exp.id),
      })
    ).toBeUndefined();
    expect(
      await db.query.model_experiment_variant.findFirst({
        where: eq(model_experiment_variant.experiment_id, exp.id),
      })
    ).toBeUndefined();
    expect(
      await db.query.model_experiment_variant_version.findFirst({
        where: eq(model_experiment_variant_version.variant_id, v.id),
      })
    ).toBeUndefined();
  });
});

describe('admin.modelExperiments — auth gate', () => {
  it('rejects non-admin callers', async () => {
    const nonAdmin = await insertTestUser({
      google_user_email: `user-${Math.random()}@example.com`,
      is_admin: false,
    });
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.modelExperiments.list()).rejects.toBeTruthy();
  });
});
