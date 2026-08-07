import { byok_api_keys, modelsByProvider } from '@kilocode/db/schema';
import { StoredModelSchema } from '@kilocode/db/schema-types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { encryptCredential, requireEncryptionKey } from '../lib/byok';
import { getSeedDb } from '../lib/db';
import { isValidEmail, resolveSeedUserId } from '../lib/users';
import type { SeedResult } from '../index';

export const usage = '<email> <provider> <model-id>';

const ALLOWED_PROVIDERS = ['minimax', 'moonshotai'];
const KEY_PREFIX = 'dev-seed:byok-e2e';
const MARKER_TAG = 'dev-seed:byok-e2e';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:byok-e2e-fixture ${usage}`);
  console.log('');
  console.log('Seeds a personal BYOK key and one Vercel metadata snapshot entry so the');
  console.log('catalog flags exactly the given model id for the user.');
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

  const userId = await resolveSeedUserId(email);
  const db = getSeedDb();

  // Reset and replace this topic's own data in one transaction: key deletion, key
  // insertion, marker cleanup, metadata validation, and snapshot insertion commit
  // together, so a validation or insert failure rolls back and never leaves the user
  // without the previous key or a half-cleaned snapshot.
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

    // Remove every models_by_provider row this topic ever wrote, across all models.
    // The marker tag never occurs in real snapshots, so a synced row is never deleted.
    await tx.delete(modelsByProvider).where(
      sql`EXISTS (
          SELECT 1 FROM jsonb_each(${modelsByProvider.vercel}) AS e(k, v)
          WHERE e.v -> 'endpoints' @> ${JSON.stringify([{ tag: MARKER_TAG }])}::jsonb
        )`
    );

    // Merge the fixture entry into a copy of the newest remaining snapshot so a real
    // synced snapshot keeps its other models (same-provider models then stay flagged).
    const [latest] = await tx
      .select({
        data: modelsByProvider.data,
        openrouter: modelsByProvider.openrouter,
        vercel: modelsByProvider.vercel,
      })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1);

    const mergedVercel = {
      ...(latest?.vercel ?? {}),
      [modelId]: {
        id: modelId,
        name: modelId,
        type: 'language',
        endpoints: [{ provider_name: provider, tag: MARKER_TAG }],
      },
    };

    // Prove the merged map parses the way the catalog endpoint later reads it.
    const parsed = z.record(z.string(), StoredModelSchema).safeParse(mergedVercel);
    if (!parsed.success) {
      throw new Error(
        `Merged vercel map failed StoredModelSchema validation: ${parsed.error.message}`
      );
    }

    await tx.insert(modelsByProvider).values({
      data: latest?.data ?? {
        providers: [],
        total_providers: 0,
        total_models: 0,
        generated_at: new Date().toISOString(),
      },
      openrouter: latest?.openrouter ?? null,
      vercel: parsed.data,
    } satisfies typeof modelsByProvider.$inferInsert);

    return insertedKey.id;
  });

  console.log('');
  console.log('This fixture represents a user who holds a personal BYOK key for the');
  console.log('provider and a catalog snapshot flagging exactly the given model id.');
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
