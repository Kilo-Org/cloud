import { connection, NextResponse } from 'next/server';
import { MODELS_BY_PROVIDER_ADMIN_URL } from '@kilocode/db/schema';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getSnapshotModelVariantId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { getModelsByProviderSnapshot } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-snapshot.server';
import {
  isModelAllowedForProviderKey,
  isModelRouteAllowed,
  resolveOrganizationMemberModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

export async function handleModelsByProviderRequest() {
  await connection();

  // Served from the shared snapshot cache: one database read per TTL, not one
  // per request.
  const snapshot = await getModelsByProviderSnapshot();

  if (snapshot === null) {
    throw new Error(
      'No models data found in database. Use the admin panel at ' + MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  const auth = await getUserFromAuth({
    adminOnly: false,
    expectedAudience: KILO_GATEWAY_AUDIENCE,
  }).catch(() => null);
  if (auth?.organizationId && auth.user) {
    // Filter to the caller's own member-effective access so the catalog agrees
    // with what the gateway (`llm-proxy.ts`) will actually allow. Owners
    // and billing managers see their own access too; the policy editor uses the
    // dedicated `organizations.groups.getPolicyEditorData` endpoint for the full
    // catalog + ceiling instead of this one.
    const policy = await resolveOrganizationMemberModelPolicy({
      organizationId: auth.organizationId,
      kiloUserId: auth.user.id,
      fromDb: readDb,
    });
    const providers = [];
    for (const provider of snapshot.providers) {
      const models = [];
      for (const model of provider.models) {
        // Evaluate the variant this provider actually serves (e.g. `x/y:free`),
        // not the collapsed slug, so a provider that only offers the free
        // variant is judged on that variant's routes. A BYOK-only provider is
        // only ever the organization's own catalog-mode key, judged as routing
        // judges that key.
        const modelId = getSnapshotModelVariantId(model);
        const allowed = provider.byokOnly
          ? await isModelAllowedForProviderKey(policy, modelId, provider.slug)
          : await isModelRouteAllowed(policy, modelId, provider.slug);
        if (allowed) models.push(model);
      }
      if (models.length > 0) providers.push({ ...provider, models });
    }
    // Per-caller body: must never populate a shared cache entry.
    return NextResponse.json(
      {
        ...snapshot,
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
  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'private, max-age=0, must-revalidate' },
  });
}
