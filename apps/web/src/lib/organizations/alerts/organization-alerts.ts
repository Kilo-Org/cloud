import type { OrganizationAlertType } from '@kilocode/db/schema';
import * as z from 'zod';
import {
  EnabledMonthlySpendingAlertConfigurationSchema,
  MONTHLY_SPENDING_ALERT_TYPE,
  MonthlySpendingAlertConfigurationSchema,
} from './monthly-spending/monthly-spending.schema';

export * from './alert-periods';
export * from './alert-recipients';
export * from './monthly-spending/monthly-spending.schema';

// Re-export the persisted shapes from the database package so app code has a
// single import site for both the runtime schemas and the types.
export type {
  MonthlySpendingAlertConfiguration,
  OrganizationAlert,
  OrganizationAlertConfiguration,
  OrganizationAlertStatus,
  OrganizationAlertType,
} from '@kilocode/db/schema';

/**
 * An alert's type is immutable, so the type permanently discriminates which
 * configuration the alert owns. Creating an alert validates against this union;
 * selecting a different type means creating a new alert identity.
 */
export const OrganizationAlertDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(MONTHLY_SPENDING_ALERT_TYPE),
      configuration: MonthlySpendingAlertConfigurationSchema,
    })
    .strict(),
]);

export type OrganizationAlertDefinition = z.infer<typeof OrganizationAlertDefinitionSchema>;

/** The definition owned by one alert type, for type-specific editors. */
export type OrganizationAlertDefinitionOf<T extends OrganizationAlertType> = Extract<
  OrganizationAlertDefinition,
  { type: T }
>;

/**
 * The same union for an alert that is being saved enabled, where the type's
 * configuration must be able to notify someone. A disabled alert keeps the base
 * union so removing every recipient is always possible. The distinction is
 * per-type rather than a shared recipient refinement because a future type may
 * need something other than a recipient to be able to notify anyone.
 */
export const EnabledOrganizationAlertDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(MONTHLY_SPENDING_ALERT_TYPE),
      configuration: EnabledMonthlySpendingAlertConfigurationSchema,
    })
    .strict(),
]);

// Adding an alert type to `@kilocode/db` is a build error until it appears in
// both definition unions with its own configuration schema. The `extends true`
// constraint is what makes a missing type fail typecheck rather than resolve to
// `false`.
type AssertTrue<T extends true> = T;

export type _AssertEveryAlertTypeIsDefined = AssertTrue<
  OrganizationAlertType extends OrganizationAlertDefinition['type'] ? true : false
>;

export type _AssertEveryAlertTypeIsDefinedWhenEnabled = AssertTrue<
  OrganizationAlertType extends z.infer<typeof EnabledOrganizationAlertDefinitionSchema>['type']
    ? true
    : false
>;
