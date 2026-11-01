import {
  EnkryptInputDetectorsSchema,
  EnkryptInputGuardrailSettingsSchema,
} from '@kilocode/db/schema-types';
import {
  createKiloDefaultEnkryptInputDetectors,
  enabledEnkryptDetectorIds,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { readStoredEnkryptDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { mutateOrganizationSettings } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationAdminMutationProcedure,
  organizationAdminProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { requireGuardrailsOrganization } from '@/lib/organizations/require-guardrails-organization';

const OrganizationGuardrailsConfigSchema = z.object({
  enabled: z.boolean(),
  scan_tool_results: z.boolean(),
  detectors: EnkryptInputDetectorsSchema,
});

export type OrganizationGuardrailsConfig = z.infer<typeof OrganizationGuardrailsConfigSchema>;

/**
 * `invalid_saved_detectors`: the saved detectors no longer validate, so the gateway rejects every
 * scanned request while the guardrail is enabled. `detectors` then holds Kilo Default as a
 * starting point for the admin to review and save.
 */
const OrganizationGuardrailsResponseSchema = OrganizationGuardrailsConfigSchema.extend({
  invalid_saved_detectors: z.boolean(),
});

/** Describes a saved configuration for the audit log without keywords, topics, or policy text. */
export function describeGuardrailsConfig(config: OrganizationGuardrailsConfig): string {
  const { detectors } = config;
  const detectorSummaries = enabledEnkryptDetectorIds(detectors).map(id => {
    const details: string[] = [];
    const detector = detectors[id];
    if ('action' in detector) details.push(detector.action);
    if (id === 'pii') details.push(detectors.pii.entities.join('/'));
    if (id === 'keyword_detector') {
      details.push(`${detectors.keyword_detector.banned_keywords.length} keywords`);
    }
    if (id === 'topic_detector') details.push(`${detectors.topic_detector.topic.length} topics`);
    if (id === 'policy_violation') {
      details.push(
        detectors.policy_violation.format === 'rules'
          ? `${detectors.policy_violation.rules.length} rules`
          : 'policy text'
      );
    }
    return details.length > 0 ? `${id} (${details.join(', ')})` : id;
  });
  const scope = config.scan_tool_results ? 'every input' : 'conversation without tool results';
  return [
    `Updated AI guardrails: ${config.enabled ? 'enabled' : 'disabled'}`,
    `checking ${scope}`,
    `detectors: ${detectorSummaries.join(', ') || 'none'}`,
  ].join('; ');
}

export const organizationGuardrailsRouter = createTRPCRouter({
  get: organizationAdminProcedure
    .output(OrganizationGuardrailsResponseSchema)
    .query(async ({ input }) => {
      const organization = await requireGuardrailsOrganization(input.organizationId);
      const settings = EnkryptInputGuardrailSettingsSchema.safeParse(
        organization.settings.enkrypt?.input_guardrail
      );
      if (!settings.success) {
        return {
          enabled: false,
          scan_tool_results: false,
          detectors: createKiloDefaultEnkryptInputDetectors(),
          invalid_saved_detectors: false,
        };
      }
      const stored = readStoredEnkryptDetectors(input.organizationId, settings.data.detectors);
      return {
        enabled: settings.data.enabled,
        scan_tool_results: settings.data.scan_tool_results ?? true,
        detectors:
          stored.status === 'found' ? stored.detectors : createKiloDefaultEnkryptInputDetectors(),
        invalid_saved_detectors: stored.status === 'invalid',
      };
    }),

  update: organizationAdminMutationProcedure
    .input(OrganizationIdInputSchema.extend(OrganizationGuardrailsConfigSchema.shape))
    .output(OrganizationGuardrailsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, ...config } = input;
      await requireGuardrailsOrganization(organizationId);
      if (config.enabled && enabledEnkryptDetectorIds(config.detectors).length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Turn on at least one detector.' });
      }
      await db.transaction(async tx => {
        await mutateOrganizationSettings(
          organizationId,
          organization => ({
            ...organization.settings,
            enkrypt: { ...organization.settings.enkrypt, input_guardrail: config },
          }),
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: describeGuardrailsConfig(config),
          organization_id: organizationId,
          tx,
        });
      });
      return { ...config, invalid_saved_detectors: false };
    }),
});
