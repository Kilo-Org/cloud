import type { MonthlySpendingAlertConfiguration } from '@kilocode/db/schema';
import * as z from 'zod';
import { AlertThresholdMicrodollarsSchema } from '../alert-thresholds';
import { OrganizationAlertPeriodDefinitionSchema } from '../alert-periods';
import {
  EnabledOrganizationAlertRecipientsSchema,
  OrganizationAlertRecipientsSchema,
} from '../alert-recipients';

export const MONTHLY_SPENDING_ALERT_TYPE = 'monthly_spending';

// Threshold parsing, formatting, and display currency are shared with every
// other alert type: re-exported here so existing imports of this module keep
// working. See `../alert-thresholds` for the canonical definitions.
export {
  AlertThresholdUsdInputSchema,
  formatAlertThresholdUsdInput,
  formatAlertUsd,
  MAX_ALERT_THRESHOLD_MICRODOLLARS,
} from '../alert-thresholds';

/**
 * `group` is validated as a UUID shape only; whether that group still exists
 * in this organization is a runtime fact the evaluator checks, not something
 * this schema can know.
 */
export const MonthlySpendingAlertScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('organization') }).strict(),
  z.object({ type: z.literal('group'), groupId: z.uuid() }).strict(),
]);

export const MonthlySpendingAlertConfigurationSchema = z
  .object({
    thresholdMicrodollars: AlertThresholdMicrodollarsSchema,
    // `calendar_month_utc` v1 is the only definition today. An unknown type or
    // version is rejected rather than interpreted as monthly.
    period: OrganizationAlertPeriodDefinitionSchema,
    scope: MonthlySpendingAlertScopeSchema,
    recipients: OrganizationAlertRecipientsSchema,
  })
  .strict();

/** Enabling or saving an enabled alert additionally requires a recipient. */
export const EnabledMonthlySpendingAlertConfigurationSchema =
  MonthlySpendingAlertConfigurationSchema.extend({
    recipients: EnabledOrganizationAlertRecipientsSchema,
  });

// Assert the runtime schema stays structurally identical to the persisted shape
// in `@kilocode/db`. The `extends true` constraint is what makes drift a build
// error rather than a conditional type that quietly resolves to `false`.
type AssertTrue<T extends true> = T;

export type _AssertMonthlySpendingConfigurationMatchesDb = AssertTrue<
  z.infer<typeof MonthlySpendingAlertConfigurationSchema> extends MonthlySpendingAlertConfiguration
    ? MonthlySpendingAlertConfiguration extends z.infer<
        typeof MonthlySpendingAlertConfigurationSchema
      >
      ? true
      : false
    : false
>;
