import { ai_gateway_metadata_cache, byok_api_keys } from '@kilocode/db/schema';
import { EndpointsSchema, ModelsSchema } from '@kilocode/db/schema-types';
import { and, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';

import { encryptCredential, requireEncryptionKey } from '../lib/byok';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> <provider> <model-id>';

const ALLOWED_PROVIDERS = ['minimax', 'moonshotai'];
const KEY_PREFIX = 'dev-seed:byok-e2e';
const MARKER_TAG = 'dev-seed:byok-e2e';
const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

const ORIGINAL_BODY_KEY = 'dev_seed_original';

const StoredModelListSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
const FixtureEndpointsRowSchema = z.object({ [ORIGINAL_BODY_KEY]: z.unknown().optional() });

function vercelModelEndpointsUrl(modelId: string) {
  return `${VERCEL_MODELS_URL}/${modelId}/endpoints`;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:byok-e2e-fixture ${usage}`);
  console.log('');
  console.log('Seeds a personal BYOK key and one stored Vercel model with endpoints so the');
  console.log('catalog flags exactly the given model id for the user. Needs the stored');
  console.log('Vercel model list from the refresh-ai-gateway-metadata-cache cron. The gateway');
  console.log('caches stored models for up to 5 minutes, and the next refresh replaces the');
  console.log('stored Vercel rows with the upstream ones.');
  console.log('');
  console.log(`Allowed providers: ${ALLOWED_PROVIDERS.join(', ')}`);
  console.log('The key is a placeholder the upstream provider rejects on purpose; the');
  console.log('rejection still writes the is_user_byok usage row. The encrypted key and');
  console.log('plaintext are never printed or returned.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:byok-e2e-fixture ada@example.com minimax minimax/minimax-m2.5');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [rawEmail, rawProvider, rawModelId, ...rest] = args;
  const email = rawEmail?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  const provider = rawProvider?.trim();
  if (!provider) {
    printUsage();
    throw new Error('provider is required');
  }
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error(`provider must be one of: ${ALLOWED_PROVIDERS.join(', ')}`);
  }
  const modelId = rawModelId?.trim();
  if (!modelId) {
    printUsage();
    throw new Error('model-id is required');
  }
  if (rest.length > 0) {
    throw new Error(`Unknown arguments: ${rest.join(' ')}`);
  }

  assertLocalSeedDatabase('app:byok-e2e-fixture');
  const userId = await resolveSeedUserId(email);
  const db = getSeedDb();

  // Reset and replace this topic's own data in one transaction: key deletion, key
  // insertion, marker cleanup, metadata validation, and metadata writes commit together,
  // so a validation or write failure rolls back and never leaves the user without the
  // previous key or half-cleaned metadata.
  const byokKeyId = await db.transaction(async tx => {
    // Reset only this topic's key data: the dedicated test account's personal key for
    // this provider. Re-running with the same user+provider is idempotent.
    await tx
      .delete(byok_api_keys)
      .where(and(eq(byok_api_keys.kilo_user_id, userId), eq(byok_api_keys.provider_id, provider)));

    const [insertedKey] = await tx
      .insert(byok_api_keys)
      .values({
        organization_id: null,
        kilo_user_id: userId,
        provider_id: provider,
        encrypted_api_key: encryptCredential(`${KEY_PREFIX}:${provider}`, requireEncryptionKey()),
        management_source: 'user',
        created_by: userId,
        is_enabled: true,
      } satisfies typeof byok_api_keys.$inferInsert)
      .returning({ id: byok_api_keys.id });
    if (!insertedKey) {
      throw new Error('Failed to create the fixture BYOK key');
    }

    // Undo every endpoints row this topic ever wrote, across all models: restore the upstream
    // body it replaced, or remove it when it replaced none. The marker never occurs in upstream
    // bodies, so refreshed metadata is never touched.
    const fixtureRows = await tx
      .select({ url: ai_gateway_metadata_cache.url, data: ai_gateway_metadata_cache.data })
      .from(ai_gateway_metadata_cache)
      .where(
        and(
          like(ai_gateway_metadata_cache.url, vercelModelEndpointsUrl('%')),
          sql`${ai_gateway_metadata_cache.data} -> 'data' -> 'endpoints' @> ${JSON.stringify([{ tag: MARKER_TAG }])}::jsonb`
        )
      );
    for (const row of fixtureRows) {
      const original = FixtureEndpointsRowSchema.parse(row.data)[ORIGINAL_BODY_KEY];
      if (original === undefined) {
        await tx
          .delete(ai_gateway_metadata_cache)
          .where(eq(ai_gateway_metadata_cache.url, row.url));
      } else {
        await tx
          .update(ai_gateway_metadata_cache)
          .set({ data: original })
          .where(eq(ai_gateway_metadata_cache.url, row.url));
      }
    }

    // Keep the other stored models, so same-provider models stay flagged. The gateway
    // rejects a list of fewer than 100 models as truncated, so a real list is required.
    const [storedList] = await tx
      .select({ data: ai_gateway_metadata_cache.data })
      .from(ai_gateway_metadata_cache)
      .where(eq(ai_gateway_metadata_cache.url, VERCEL_MODELS_URL));
    if (!storedList) {
      throw new Error(
        'No stored Vercel model list. Run the refresh-ai-gateway-metadata-cache cron first.'
      );
    }
    const listedModels = StoredModelListSchema.parse(storedList.data).data.filter(
      model => model.dev_seed !== MARKER_TAG
    );
    const list = {
      data: listedModels.some(model => model.id === modelId)
        ? listedModels
        : [...listedModels, { id: modelId, name: modelId, type: 'language', dev_seed: MARKER_TAG }],
    };
    const [upstreamEndpoints] = await tx
      .select({ data: ai_gateway_metadata_cache.data })
      .from(ai_gateway_metadata_cache)
      .where(eq(ai_gateway_metadata_cache.url, vercelModelEndpointsUrl(modelId)));
    const endpoints = {
      data: { endpoints: [{ provider_name: provider, tag: MARKER_TAG }] },
      ...(upstreamEndpoints && { [ORIGINAL_BODY_KEY]: upstreamEndpoints.data }),
    };

    // Prove both rows parse the way the gateway later reads them.
    const parsedList = ModelsSchema.safeParse(list);
    if (!parsedList.success) {
      throw new Error(`Stored Vercel model list failed validation: ${parsedList.error.message}`);
    }
    const parsedEndpoints = EndpointsSchema.safeParse(endpoints);
    if (!parsedEndpoints.success) {
      throw new Error(`Fixture endpoints failed validation: ${parsedEndpoints.error.message}`);
    }

    for (const row of [
      { url: VERCEL_MODELS_URL, data: list },
      { url: vercelModelEndpointsUrl(modelId), data: endpoints },
    ]) {
      await tx
        .insert(ai_gateway_metadata_cache)
        .values(row satisfies typeof ai_gateway_metadata_cache.$inferInsert)
        .onConflictDoUpdate({
          target: ai_gateway_metadata_cache.url,
          set: { data: row.data, updated_at: sql`now()` },
        });
    }

    return insertedKey.id;
  });

  console.log('');
  console.log('This fixture represents a user who holds a personal BYOK key for the');
  console.log('provider and stored Vercel metadata flagging exactly the given model id.');
  console.log('The placeholder key is rejected upstream; the usage row still records');
  console.log('is_user_byok = true for the turn.');

  return {
    userId,
    byokKeyId,
    providerId: provider,
    modelId,
    enabled: true,
  };
}
