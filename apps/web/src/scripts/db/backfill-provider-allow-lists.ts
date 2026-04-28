import { db } from '@/lib/drizzle';
import { modelsByProvider, organizations } from '@kilocode/db/schema';
import { desc, eq } from 'drizzle-orm';

const isApply = process.argv.includes('--apply');

export function getProviderAllowListFromDenyList(params: {
  providerSlugs: string[];
  providerDenyList: string[] | undefined;
}) {
  const deniedProviders = new Set(params.providerDenyList ?? []);
  return params.providerSlugs.filter(provider => !deniedProviders.has(provider));
}

function hasProviderPolicy(settings: typeof organizations.$inferSelect.settings) {
  return settings.provider_policy_mode === 'allow' && settings.provider_allow_list !== undefined;
}

function hasProviderDenyList(settings: typeof organizations.$inferSelect.settings) {
  return settings.provider_deny_list !== undefined;
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

  const providerSlugs = snapshot.providers
    .filter(provider => provider.models.some(model => model.endpoint))
    .map(provider => provider.slug);

  const orgs = await db.query.organizations.findMany({
    where: eq(organizations.plan, 'enterprise'),
  });

  let changed = 0;
  for (const org of orgs) {
    if (hasProviderPolicy(org.settings) || !hasProviderDenyList(org.settings)) continue;

    const settings = {
      ...org.settings,
      provider_policy_mode: 'allow' as const,
      provider_allow_list: getProviderAllowListFromDenyList({
        providerSlugs,
        providerDenyList: org.settings.provider_deny_list,
      }),
    };

    changed++;
    console.log(
      `${isApply ? 'Updating' : 'Would update'} ${org.id}: ${settings.provider_allow_list.length} providers`
    );

    if (!isApply) continue;

    await db.update(organizations).set({ settings }).where(eq(organizations.id, org.id));
  }

  console.log(`${isApply ? 'Updated' : 'Would update'} ${changed} organizations`);
}
