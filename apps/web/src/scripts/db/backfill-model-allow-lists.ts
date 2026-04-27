import { db } from '@/lib/drizzle';
import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import { modelsByProvider, organizations } from '@kilocode/db/schema';
import { desc, eq } from 'drizzle-orm';

const isApply = process.argv.includes('--apply');

function unique(values: string[]) {
  return [...new Set(values)];
}

function hasAllowList(settings: typeof organizations.$inferSelect.settings) {
  return settings.model_allow_list !== undefined || settings.provider_allow_list !== undefined;
}

function hasDenyList(settings: typeof organizations.$inferSelect.settings) {
  return settings.model_deny_list !== undefined || settings.provider_deny_list !== undefined;
}

export async function run() {
  const snapshots = await db
    .select({ data: modelsByProvider.data })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  const snapshot = snapshots[0]?.data;
  if (!snapshot) {
    throw new Error('No models_by_provider snapshot found');
  }

  const providers = snapshot.providers.filter(provider =>
    provider.models.some(model => model.endpoint)
  );
  const providerSlugs = providers.map(provider => provider.slug);
  const modelIds = unique(
    providers.flatMap(provider =>
      provider.models.filter(model => model.endpoint).map(model => normalizeModelId(model.slug))
    )
  );

  const orgs = await db.query.organizations.findMany({
    where: eq(organizations.plan, 'enterprise'),
  });

  let changed = 0;
  for (const org of orgs) {
    if (hasAllowList(org.settings) || !hasDenyList(org.settings)) continue;

    const deniedModels = new Set(org.settings.model_deny_list?.map(normalizeModelId) ?? []);
    const deniedProviders = new Set(org.settings.provider_deny_list ?? []);
    const settings = {
      ...org.settings,
      model_allow_list: modelIds.filter(model => !deniedModels.has(model)),
      provider_allow_list: providerSlugs.filter(provider => !deniedProviders.has(provider)),
    };

    changed++;
    console.log(
      `${isApply ? 'Updating' : 'Would update'} ${org.id}: ${settings.provider_allow_list.length} providers, ${settings.model_allow_list.length} models`
    );

    if (!isApply) continue;

    await db.update(organizations).set({ settings }).where(eq(organizations.id, org.id));
  }

  console.log(`${isApply ? 'Updated' : 'Would update'} ${changed} organizations`);
}
