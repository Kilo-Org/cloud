import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveOrganizationBotModel } from '@/lib/bot/organization-model';
import { z } from 'zod';

type BotModelIntegration = {
  metadata: unknown;
};

const BotModelMetadataSchema = z
  .object({
    model_slug: z.string().trim().min(1),
  })
  .passthrough();

export function resolveBotModelSlug(integration: BotModelIntegration | null | undefined): string {
  const parsed = BotModelMetadataSchema.safeParse(integration?.metadata);
  if (!parsed.success) return DEFAULT_BOT_MODEL;

  return parsed.data.model_slug;
}

/**
 * The model a bot run uses, resolved for the integration's owner. An
 * organization-owned integration gets the stored slug only while the
 * organization's current policy allows it, otherwise the organization's allowed
 * default, or `null` when the policy allows none: the caller then refuses the
 * run. A user-owned integration keeps `resolveBotModelSlug`'s result.
 */
export async function resolveBotRunModel(
  integration:
    | (BotModelIntegration & { owned_by_organization_id?: string | null })
    | null
    | undefined
): Promise<string | null> {
  return resolveOrganizationBotModel({
    organizationId: integration?.owned_by_organization_id ?? null,
    storedModelSlug: resolveBotModelSlug(integration),
  });
}
