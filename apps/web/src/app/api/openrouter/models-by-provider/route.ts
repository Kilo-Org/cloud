import { connection, NextResponse } from 'next/server';
import { MODELS_BY_PROVIDER_ADMIN_URL, modelsByProvider } from '@kilocode/db/schema';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationMemberModelPolicy,
} from '@/lib/organizations/effective-model-access.server';

export async function GET() {
  await connection();

  const result = await db
    .select()
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  if (!result || result.length === 0) {
    throw new Error(
      'No models data found in database. Use the admin panel at ' + MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  const auth = await getUserFromAuth({ adminOnly: false }).catch(() => null);
  if (auth?.organizationId && auth.user) {
    // Filter to the caller's own member-effective access so the catalog agrees
    // with what the gateway (`[...path]/route.ts`) will actually allow. Owners
    // and billing managers see their own access too; the policy editor uses the
    // dedicated `organizations.groups.getPolicyEditorData` endpoint for the full
    // catalog + ceiling instead of this one.
    const policy = await resolveOrganizationMemberModelPolicy({
      organizationId: auth.organizationId,
      kiloUserId: auth.user.id,
    });
    const providers = [];
    for (const provider of result[0].data.providers) {
      const models = [];
      for (const model of provider.models) {
        const decision = await getEffectiveModelDecision(policy, model.slug);
        if (
          decision.allowed &&
          (!decision.eligibleProviderRoutes || decision.eligibleProviderRoutes.has(provider.slug))
        ) {
          models.push(model);
        }
      }
      if (models.length > 0) providers.push({ ...provider, models });
    }
    // Per-caller body: must never populate a shared cache entry.
    return NextResponse.json(
      {
        ...result[0].data,
        providers,
        total_providers: providers.length,
        total_models: providers.reduce((total, provider) => total + provider.models.length, 0),
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  }

  // The response now varies by authenticated organization, so a shared-cache
  // entry could otherwise be served to an org member and bypass filtering.
  // Keep this catalog per-client rather than shared (`s-maxage`).
  return NextResponse.json(result[0].data, {
    headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
  });
}
