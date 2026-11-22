/**
 * Seeds the catalog rows and one enterprise organization that the provider
 * allow-list differential needs: an OpenRouter catalogue with a real provider
 * list, a models-by-provider snapshot, and an enterprise org whose stored
 * provider_allow_list uses the mixed-case slug passed in. Local dev DB only.
 *
 * Run from the repo root:
 *   pnpm -s exec tsx dev/local/seed-provider-allow-list-fixture.mts \
 *     --owner <kilo user id> --slug <stored slug> [--org <uuid>]
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  ai_gateway_metadata_cache,
  modelsByProvider,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { assertLocalSeedDatabase, closeSeedDb, getSeedDb } from '../seed/lib/db';

function flagValue(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name} <value>`);
  }
  return value;
}

const ownerId = flagValue('--owner');
const storedSlug = flagValue('--slug');
const organizationId = flagValue('--org', randomUUID());

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const SERVED = [
  { modelId: 'fixture-openai/model', provider: 'OpenAI', providerSlug: 'openai' },
  { modelId: 'fixture-anthropic/model', provider: 'Anthropic', providerSlug: 'anthropic' },
];

function catalogueModel(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    created: 1_700_000_000,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false, context_length: 128_000, max_completion_tokens: 8_000 },
    pricing: { prompt: '0', completion: '0' },
    context_length: 128_000,
  };
}

const catalogue = {
  data: [
    ...SERVED.map(served => catalogueModel(served.modelId)),
    // The reader rejects a catalogue under 100 entries, so these are filler that
    // no provider serves and no allow list names.
    ...Array.from({ length: 120 }, (_, index) => catalogueModel(`fixture-filler/model-${index}`)),
  ],
};

const snapshot = {
  generated_at: '2026-11-22T00:00:00.000Z',
  total_providers: SERVED.length,
  total_models: SERVED.length,
  providers: SERVED.map(served => ({
    name: served.provider,
    displayName: served.provider,
    slug: served.providerSlug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models: [
      {
        slug: served.modelId,
        name: served.modelId,
        author: served.provider.toLowerCase(),
        description: '',
        context_length: 128_000,
        input_modalities: ['text'],
        output_modalities: ['text'],
        group: 'other',
        updated_at: '2026-01-01T00:00:00.000Z',
        endpoint: {
          provider_display_name: served.provider,
          variant: 'standard',
          is_free: false,
          pricing: { prompt: '0', completion: '0' },
        },
      },
    ],
  })),
};

assertLocalSeedDatabase('seed-provider-allow-list-fixture');
const db = getSeedDb();

await db
  .insert(ai_gateway_metadata_cache)
  .values({ url: CATALOGUE_URL, data: catalogue })
  .onConflictDoUpdate({ target: ai_gateway_metadata_cache.url, set: { data: catalogue } });

// Keep exactly one fixture snapshot, so a re-run never leaves two rows behind.
await db.delete(modelsByProvider).where(sql`true`);
await db.insert(modelsByProvider).values({ data: snapshot });

// `require_seats: false` bypasses trial enforcement, so the owner may write the
// allow list without a seat purchase. An older `created_at` keeps the dashboard
// from replacing its cards with the new-organization welcome panel.
const settings = { provider_allow_list: [storedSlug] };
const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
await db
  .insert(organizations)
  .values({
    id: organizationId,
    name: 'Provider allow-list fixture',
    plan: 'enterprise',
    require_seats: false,
    created_by_kilo_user_id: ownerId,
    created_at: createdAt.toISOString(),
    settings,
  })
  .onConflictDoUpdate({
    target: organizations.id,
    set: { settings, plan: 'enterprise', require_seats: false, created_at: createdAt.toISOString() },
  });

await db
  .insert(organization_memberships)
  .values({ organization_id: organizationId, kilo_user_id: ownerId, role: 'owner' })
  .onConflictDoUpdate({
    target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
    set: { role: 'owner' },
  });

const [stored] = await db
  .select({ settings: organizations.settings })
  .from(organizations)
  .where(eq(organizations.id, organizationId));

console.log(`org=${organizationId}`);
console.log(`catalogue entries=${catalogue.data.length}`);
console.log(`snapshot providers=${SERVED.map(served => served.providerSlug).join(',')}`);
console.log(`stored settings=${JSON.stringify(stored?.settings)}`);
await closeSeedDb();
