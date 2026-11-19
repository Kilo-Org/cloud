import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import type { CustomRouterDefinition } from '@kilocode/auto-routing-contracts';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { listUsableCustomRouters } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import {
  addAutoRoutingModels,
  addCustomRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';

/**
 * The custom routers usable with the given personal or organization scope. A listing
 * failure answers no routers so the catalog still serves; the route that asked keeps its
 * own failure behaviour for the rest of its work.
 */
export async function usableCustomRouters(params: {
  userId: string;
  organizationId: string | null;
  endpoint: string;
}): Promise<CustomRouterDefinition[]> {
  try {
    return await listUsableCustomRouters({
      userId: params.userId,
      organizationId: params.organizationId,
    });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: params.endpoint },
      extra: {
        action: 'listing_custom_routers',
        userId: params.userId,
        organizationId: params.organizationId,
      },
    });
    return [];
  }
}

/**
 * The member-effective organization catalog composed exactly as `GET /api/v1/models`
 * serves it: organization policy, the auto-routing step, and the custom routers usable in
 * that context.
 */
export async function organizationMemberCatalog(params: {
  organizationId: string;
  kiloUserId: string;
  countryCode: string | null;
  endpoint: string;
}): Promise<OpenRouterModelsResponse | null> {
  const result = await getAvailableModelsForOrganization(
    params.organizationId,
    { type: 'member', kiloUserId: params.kiloUserId },
    'member',
    { fromDb: readDb, countryCode: params.countryCode }
  );
  if (!result) {
    return null;
  }
  const [models, customRouters] = await Promise.all([
    addAutoRoutingModels(result.data),
    usableCustomRouters({
      userId: params.kiloUserId,
      organizationId: params.organizationId,
      endpoint: params.endpoint,
    }),
  ]);
  return { ...result, data: addCustomRouterModels(models, customRouters) };
}

/**
 * The credential cannot read this organization's catalog: either the organization is gone
 * or the membership row is not visible to this read. Neither is retryable and neither is a
 * server fault.
 */
export function isUnreadableOrganizationError(error: unknown): boolean {
  return (
    error instanceof TRPCError && (error.code === 'NOT_FOUND' || error.code === 'UNAUTHORIZED')
  );
}
