import type { LowBalanceAlertConfiguration } from '@kilocode/db/schema';
import * as z from 'zod';
import { AlertThresholdMicrodollarsSchema } from '../alert-thresholds';
import {
  EnabledOrganizationAlertRecipientsSchema,
  OrganizationAlertRecipientsSchema,
} from '../alert-recipients';

export const LOW_BALANCE_ALERT_TYPE = 'low_balance';

/**
 * Unlike `monthly_spending`, this configuration has no `period`: the alert
 * watches the organization's current balance continuously rather than resetting
 * on a calendar boundary. See `low-balance-evaluator.ts` for how an occurrence
 * identity is derived from the crossing event itself instead.
 */
export const LowBalanceAlertConfigurationSchema = z
  .object({
    thresholdMicrodollars: AlertThresholdMicrodollarsSchema,
    recipients: OrganizationAlertRecipientsSchema,
  })
  .strict();

/** Enabling or saving an enabled alert additionally requires a recipient. */
export const EnabledLowBalanceAlertConfigurationSchema = LowBalanceAlertConfigurationSchema.extend({
  recipients: EnabledOrganizationAlertRecipientsSchema,
});

// Assert the runtime schema stays structurally identical to the persisted shape
// in `@kilocode/db`. The `extends true` constraint is what makes drift a build
// error rather than a conditional type that quietly resolves to `false`.
type AssertTrue<T extends true> = T;

export type _AssertLowBalanceConfigurationMatchesDb = AssertTrue<
  z.infer<typeof LowBalanceAlertConfigurationSchema> extends LowBalanceAlertConfiguration
    ? LowBalanceAlertConfiguration extends z.infer<typeof LowBalanceAlertConfigurationSchema>
      ? true
      : false
    : false
>;
