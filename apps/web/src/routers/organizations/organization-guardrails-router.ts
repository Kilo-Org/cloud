import {
  ENKRYPT_DETECTOR_IDS,
  ENKRYPT_OUTPUT_DETECTOR_IDS,
  EnkryptInputDetectorsSchema,
  EnkryptInputDetectorsUpdateSchema,
  EnkryptInputGuardrailSettingsSchema,
  EnkryptOutputDetectorsSchema,
  EnkryptOutputDetectorsUpdateSchema,
  EnkryptOutputGuardrailSettingsSchema,
  type OrganizationSettings,
} from '@kilocode/db/schema-types';
import { organization_groups } from '@kilocode/db/schema';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
  enabledEnkryptOutputDetectorIds,
  ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS,
  enforcedEnkryptInputDetectors,
  storableEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import {
  enkryptInputGuardrailGroupId,
  readStoredEnkryptDetectors,
  readStoredEnkryptOutputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import { lockOrganizationGroupPolicy } from '@kilocode/web-shared/lib/organizations/organization-groups';
import { mutateOrganizationSettings } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationAdminMutationProcedure,
  organizationAdminProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { and, asc, eq } from 'drizzle-orm';
import * as z from 'zod';
import { requireGuardrailsOrganization } from '@/lib/organizations/require-guardrails-organization';

const OrganizationOutputGuardrailConfigSchema = z.object({
  enabled: z.boolean(),
  detectors: EnkryptOutputDetectorsSchema,
});

/** `group_id`: the organization group the input guardrail is limited to; null for every member. */
const OrganizationGuardrailsConfigSchema = z.object({
  enabled: z.boolean(),
  group_id: z.uuid().nullable(),
  detectors: EnkryptInputDetectorsSchema,
  output: OrganizationOutputGuardrailConfigSchema,
});

/**
 * Saves cap policies at fewer rules than saved settings may hold. Omitting `output` preserves
 * output guardrails when their configuration UI is unavailable, and omitting `group_id` preserves
 * the saved group for clients from before it could be chosen.
 */
const OrganizationGuardrailsUpdateSchema = OrganizationGuardrailsConfigSchema.extend({
  group_id: z.uuid().nullable().optional(),
  detectors: EnkryptInputDetectorsUpdateSchema,
  output: OrganizationOutputGuardrailConfigSchema.extend({
    detectors: EnkryptOutputDetectorsUpdateSchema,
  }).optional(),
});

export type OrganizationGuardrailsConfig = z.infer<typeof OrganizationGuardrailsConfigSchema>;

const GuardrailGroupSchema = z.object({ id: z.string(), name: z.string() });

type GuardrailGroup = z.infer<typeof GuardrailGroupSchema>;

/**
 * `invalid_saved_detectors`: the saved input detectors no longer validate, so the gateway rejects
 * every scanned request while the guardrail is enabled. `detectors` then holds Kilo Default as a
 * starting point for the admin to review and save. `invalid_saved_output_detectors` is the same for
 * the output guardrail, which then withholds every response and starts from no detector. `groups`
 * are the organization groups the input guardrail can be limited to.
 */
const OrganizationGuardrailsResponseSchema = OrganizationGuardrailsConfigSchema.extend({
  groups: z.array(GuardrailGroupSchema),
  output_available: z.boolean(),
  invalid_saved_detectors: z.boolean(),
  invalid_saved_output_detectors: z.boolean(),
});

type DescribedDetector = {
  enabled: boolean;
  action?: string;
  entities?: string[];
  banned_keywords?: string[];
  topic?: string[];
  format?: string;
  rules?: unknown[];
};

function describeDetectors<Id extends string>(
  ids: readonly Id[],
  detectors: Record<Id, DescribedDetector>
): string {
  const summaries = ids.flatMap(id => {
    const detector = detectors[id];
    if (!detector.enabled) return [];
    const details: string[] = [];
    if (detector.action) details.push(detector.action);
    if (detector.entities) details.push(detector.entities.join('/'));
    if (detector.banned_keywords) details.push(`${detector.banned_keywords.length} keywords`);
    if (detector.topic) details.push(`${detector.topic.length} topics`);
    if (detector.format) {
      details.push(
        detector.format === 'rules' ? `${detector.rules?.length ?? 0} rules` : 'policy text'
      );
    }
    return [details.length > 0 ? `${id} (${details.join(', ')})` : id];
  });
  return summaries.join(', ') || 'none';
}

/**
 * Describes a saved configuration for the audit log without keywords, topics, or policy text.
 * Input detectors are described as the gateway enforces them.
 */
export function describeGuardrailsConfig(
  config: OrganizationGuardrailsConfig,
  group: GuardrailGroup | null
): string {
  return [
    `Updated AI guardrails: ${config.enabled ? 'enabled' : 'disabled'}`,
    `applies to: ${group ? `group "${group.name}" (${group.id})` : 'all members'}`,
    `detectors: ${describeDetectors(ENKRYPT_DETECTOR_IDS, enforcedEnkryptInputDetectors(config.detectors))}`,
    `output guardrails: ${config.output.enabled ? 'enabled' : 'disabled'}`,
    `output detectors: ${describeDetectors(ENKRYPT_OUTPUT_DETECTOR_IDS, config.output.detectors)}`,
  ].join('; ');
}

function savedInputGuardrail(organizationId: string, settings: OrganizationSettings) {
  const saved = EnkryptInputGuardrailSettingsSchema.safeParse(settings.enkrypt?.input_guardrail);
  if (!saved.success) {
    return {
      enabled: false,
      group_id: null,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      invalid_saved_detectors: false,
    };
  }
  const stored = readStoredEnkryptDetectors(organizationId, saved.data.detectors);
  return {
    enabled: saved.data.enabled,
    group_id: enkryptInputGuardrailGroupId(settings),
    detectors:
      stored.status === 'found' ? stored.detectors : createKiloDefaultEnkryptInputDetectors(),
    invalid_saved_detectors: stored.status === 'invalid',
  };
}

async function listGuardrailGroups(organizationId: string): Promise<GuardrailGroup[]> {
  return await db
    .select({ id: organization_groups.id, name: organization_groups.name })
    .from(organization_groups)
    .where(eq(organization_groups.organization_id, organizationId))
    .orderBy(asc(organization_groups.name));
}

/**
 * Holds the group-policy lock so a group cannot be deleted between this check and the save; see
 * `deleteOrganizationGroup`.
 */
async function lockGuardrailGroup(
  tx: DrizzleTransaction,
  organizationId: string,
  groupId: string
): Promise<GuardrailGroup> {
  await lockOrganizationGroupPolicy(tx, organizationId);
  const [group] = await tx
    .select({ id: organization_groups.id, name: organization_groups.name })
    .from(organization_groups)
    .where(
      and(
        eq(organization_groups.organization_id, organizationId),
        eq(organization_groups.id, groupId)
      )
    )
    .limit(1);
  if (!group) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an existing group.' });
  }
  return group;
}

function savedOutputGuardrail(organizationId: string, settings: OrganizationSettings) {
  const saved = EnkryptOutputGuardrailSettingsSchema.safeParse(settings.enkrypt?.output_guardrail);
  if (!saved.success) {
    return {
      output: { enabled: false, detectors: createEmptyEnkryptOutputDetectors() },
      invalid_saved_output_detectors: false,
    };
  }
  const stored = readStoredEnkryptOutputDetectors(organizationId, saved.data.detectors);
  return {
    output: {
      enabled: saved.data.enabled,
      detectors: stored.status === 'found' ? stored.detectors : createEmptyEnkryptOutputDetectors(),
    },
    invalid_saved_output_detectors: stored.status === 'invalid',
  };
}

async function isOutputGuardrailAvailable(organizationId: string): Promise<boolean> {
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(db),
    'enkrypt_output_guardrail',
    organizationId
  );
}

export const organizationGuardrailsRouter = createTRPCRouter({
  get: organizationAdminProcedure
    .output(OrganizationGuardrailsResponseSchema)
    .query(async ({ input }) => {
      const organization = await requireGuardrailsOrganization(input.organizationId);
      return {
        output_available: await isOutputGuardrailAvailable(input.organizationId),
        groups: await listGuardrailGroups(input.organizationId),
        ...savedInputGuardrail(input.organizationId, organization.settings),
        ...savedOutputGuardrail(input.organizationId, organization.settings),
      };
    }),

  update: organizationAdminMutationProcedure
    .input(OrganizationIdInputSchema.extend(OrganizationGuardrailsUpdateSchema.shape))
    .output(OrganizationGuardrailsResponseSchema)
    .mutation(async ({ input, ctx }) => {
      const {
        organizationId,
        output: requestedOutput,
        group_id: requestedGroupId,
        ...detectorSettings
      } = input;
      const { settings } = await requireGuardrailsOrganization(organizationId);
      const inputGuardrail = {
        ...detectorSettings,
        group_id:
          requestedGroupId !== undefined
            ? requestedGroupId
            : savedInputGuardrail(organizationId, settings).group_id,
      };
      const outputAvailable = await isOutputGuardrailAvailable(organizationId);
      if (requestedOutput && !outputAvailable) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Enkrypt output guardrails are not available for this organization.',
        });
      }
      const { output, invalid_saved_output_detectors } = requestedOutput
        ? { output: requestedOutput, invalid_saved_output_detectors: false }
        : savedOutputGuardrail(organizationId, settings);
      const config = { ...inputGuardrail, output };
      if (
        inputGuardrail.enabled &&
        !ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS.some(id => inputGuardrail.detectors[id].enabled)
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Turn on at least one input detector.',
        });
      }
      if (
        requestedOutput?.enabled &&
        enabledEnkryptOutputDetectorIds(requestedOutput.detectors).length === 0
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Turn on at least one output detector.',
        });
      }
      await db.transaction(async tx => {
        const group = inputGuardrail.group_id
          ? await lockGuardrailGroup(tx, organizationId, inputGuardrail.group_id)
          : null;
        await mutateOrganizationSettings(
          organizationId,
          organization => ({
            ...organization.settings,
            enkrypt: {
              ...organization.settings.enkrypt,
              input_guardrail: {
                ...inputGuardrail,
                detectors: storableEnkryptInputDetectors(inputGuardrail.detectors),
              },
              ...(requestedOutput ? { output_guardrail: requestedOutput } : {}),
            },
          }),
          tx
        );
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: describeGuardrailsConfig(config, group),
          organization_id: organizationId,
          tx,
        });
      });
      return {
        ...config,
        groups: await listGuardrailGroups(organizationId),
        output_available: outputAvailable,
        invalid_saved_detectors: false,
        invalid_saved_output_detectors,
      };
    }),
});
