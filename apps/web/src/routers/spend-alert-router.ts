import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { eq } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  organizations,
  user_notification_preferences,
  user_push_tokens,
} from '@kilocode/db/schema';
import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  MICRODOLLARS_PER_USD,
  readSpendAlertSettings,
  saveSpendAlertSettings,
  type SpendAlertRuleConfig,
  type SpendAlertScope,
  type SpendAlertRuleView,
} from '@/lib/spend-alerts/settings';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SpendAlertRuleKindSchema = z.enum(['threshold', 'anomaly']);
const SpendAlertWindowHoursSchema = z.union([z.literal(24), z.literal(168), z.literal(720)]);

const SpendAlertRuleInputSchema = z
  .object({
    kind: SpendAlertRuleKindSchema,
    enabled: z.boolean(),
    /** Rolling-window threshold in USD. Required for the threshold kind. */
    threshold: z.number().positive().max(1_000_000).nullish(),
    windowHours: SpendAlertWindowHoursSchema.nullish(),
    /** Anomaly multiplier in basis points (100 = 1x). Required for the anomaly kind. */
    multiplierBasisPoints: z.number().int().min(100).max(5000).nullish(),
    emailEnabled: z.boolean(),
    pushEnabled: z.boolean(),
  })
  .superRefine((rule, ctx) => {
    if (rule.kind === 'threshold') {
      if (rule.threshold == null) {
        ctx.addIssue({ code: 'custom', message: 'A threshold rule needs a USD threshold.' });
      }
      if (rule.windowHours == null) {
        ctx.addIssue({ code: 'custom', message: 'A threshold rule needs a rolling window.' });
      }
    } else if (rule.multiplierBasisPoints == null) {
      ctx.addIssue({ code: 'custom', message: 'An anomaly rule needs a multiplier.' });
    }
  });

const SpendAlertRulesInputSchema = z.array(SpendAlertRuleInputSchema).superRefine((rules, ctx) => {
  const kinds = new Set(rules.map(rule => rule.kind));
  if (kindCount(rules, 'threshold') !== 1 || kindCount(rules, 'anomaly') !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide exactly one threshold rule and one anomaly rule.',
    });
  }
  if (kinds.size !== rules.length) {
    ctx.addIssue({ code: 'custom', message: 'Each rule kind may only appear once.' });
  }
});

function kindCount(
  rules: { kind: SpendAlertRuleConfig['kind'] }[],
  kind: SpendAlertRuleConfig['kind']
) {
  return rules.filter(rule => rule.kind === kind).length;
}

const GetInputSchema = z.object({
  organizationId: z.uuid().optional(),
});

const SaveInputSchema = z.object({
  organizationId: z.uuid().optional(),
  enabled: z.boolean(),
  rules: SpendAlertRulesInputSchema,
});

const SpendAlertSpendSchema = z.object({
  spend24hMicrodollars: z.number(),
  spend7dMicrodollars: z.number(),
  baselineHourlyMicrodollars: z.number().nullable(),
});

const SpendAlertRuleOutputSchema = z.object({
  kind: SpendAlertRuleKindSchema,
  enabled: z.boolean(),
  /** Rolling-window threshold in USD. */
  threshold: z.number().nullable(),
  windowHours: z.number().nullable(),
  multiplierBasisPoints: z.number().nullable(),
  emailEnabled: z.boolean(),
  pushEnabled: z.boolean(),
  firing: z.boolean(),
});

const SpendAlertOutputSchema = z.object({
  scope: z.enum(['personal', 'organization']),
  scopeName: z.string(),
  canManage: z.boolean(),
  /** The viewer's own mobile notification category, the push delivery gate. */
  pushCategoryEnabled: z.boolean(),
  /** True when the viewer has no registered mobile device, so push cannot reach them. */
  pushChannelBlocked: z.boolean(),
  // Absent for a caller who may see the scope but not manage its settings: that
  // is the non-retryable state the surface renders as absence.
  enabled: z.boolean().optional(),
  rules: z.array(SpendAlertRuleOutputSchema).optional(),
  spend: SpendAlertSpendSchema.optional(),
});

type SpendAlertOutput = z.infer<typeof SpendAlertOutputSchema>;

// ---------------------------------------------------------------------------
// Mapping between the wire (USD) and the stored (microdollars) representation
// ---------------------------------------------------------------------------

function toWireRule(rule: SpendAlertRuleView): z.infer<typeof SpendAlertRuleOutputSchema> {
  return {
    kind: rule.kind,
    enabled: rule.enabled,
    threshold:
      rule.thresholdMicrodollars == null ? null : rule.thresholdMicrodollars / MICRODOLLARS_PER_USD,
    windowHours: rule.windowHours,
    multiplierBasisPoints: rule.multiplierBasisPoints,
    emailEnabled: rule.emailEnabled,
    pushEnabled: rule.pushEnabled,
    firing: rule.firing,
  };
}

function toStoredRule(rule: z.infer<typeof SpendAlertRuleInputSchema>): SpendAlertRuleConfig {
  return {
    kind: rule.kind,
    enabled: rule.enabled,
    thresholdMicrodollars:
      rule.threshold == null ? null : Math.round(rule.threshold * MICRODOLLARS_PER_USD),
    windowHours: rule.windowHours ?? null,
    multiplierBasisPoints: rule.multiplierBasisPoints ?? null,
    emailEnabled: rule.emailEnabled,
    pushEnabled: rule.pushEnabled,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

async function readSpendAlertsCategoryEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: user_notification_preferences.spend_alerts_enabled })
    .from(user_notification_preferences)
    .where(eq(user_notification_preferences.user_id, userId))
    .limit(1);
  return row?.enabled ?? true;
}

async function isPushChannelBlocked(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: user_push_tokens.id })
    .from(user_push_tokens)
    .where(eq(user_push_tokens.user_id, userId))
    .limit(1);
  return row === undefined;
}

async function readOrganizationName(organizationId: string): Promise<string> {
  const [organization] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return organization.name;
}

function settingsPayload(
  settings: Awaited<ReturnType<typeof readSpendAlertSettings>>
): Pick<SpendAlertOutput, 'enabled' | 'rules' | 'spend'> {
  return {
    enabled: settings.enabled,
    rules: settings.rules.map(toWireRule),
    spend: settings.spend,
  };
}

// ---------------------------------------------------------------------------
// Router definition
// ---------------------------------------------------------------------------

export const spendAlertRouter = createTRPCRouter({
  get: baseProcedure
    .input(GetInputSchema)
    .output(SpendAlertOutputSchema)
    .query(async ({ input, ctx }): Promise<SpendAlertOutput> => {
      const [pushCategoryEnabled, pushChannelBlocked] = await Promise.all([
        readSpendAlertsCategoryEnabled(ctx.user.id),
        isPushChannelBlocked(ctx.user.id),
      ]);

      if (!input.organizationId) {
        const scope: SpendAlertScope = { type: 'personal', userId: ctx.user.id };
        const settings = await readSpendAlertSettings(db, scope);
        return {
          scope: 'personal',
          scopeName: ctx.user.google_user_name,
          canManage: true,
          pushCategoryEnabled,
          pushChannelBlocked,
          ...settingsPayload(settings),
        };
      }

      // Any member may see who owns the scope; only a billing role sees the
      // settings themselves.
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      const scopeName = await readOrganizationName(input.organizationId);
      const canManage = canManageOrganizationBilling(role);

      if (!canManage) {
        return {
          scope: 'organization',
          scopeName,
          canManage: false,
          pushCategoryEnabled,
          pushChannelBlocked,
        };
      }

      const settings = await readSpendAlertSettings(db, {
        type: 'organization',
        organizationId: input.organizationId,
      });
      return {
        scope: 'organization',
        scopeName,
        canManage: true,
        pushCategoryEnabled,
        pushChannelBlocked,
        ...settingsPayload(settings),
      };
    }),

  save: baseProcedure
    .input(SaveInputSchema)
    .output(SpendAlertOutputSchema)
    .mutation(async ({ input, ctx }): Promise<SpendAlertOutput> => {
      let scope: SpendAlertScope;
      let scopeName: string;

      if (input.organizationId) {
        const role = await ensureOrganizationAccess(ctx, input.organizationId);
        if (!canManageOrganizationBilling(role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to manage this organization’s spend alerts',
          });
        }
        scope = { type: 'organization', organizationId: input.organizationId };
        scopeName = await readOrganizationName(input.organizationId);
      } else {
        scope = { type: 'personal', userId: ctx.user.id };
        scopeName = ctx.user.google_user_name;
      }

      const settings = await saveSpendAlertSettings(db, scope, {
        enabled: input.enabled,
        rules: input.rules.map(toStoredRule),
        viewerUserId: ctx.user.id,
      });

      const [pushCategoryEnabled, pushChannelBlocked] = await Promise.all([
        readSpendAlertsCategoryEnabled(ctx.user.id),
        isPushChannelBlocked(ctx.user.id),
      ]);

      return {
        scope: scope.type,
        scopeName,
        canManage: true,
        pushCategoryEnabled,
        pushChannelBlocked,
        ...settingsPayload(settings),
      };
    }),
});
