export * from '../../../services/cloud-agent-next/src/shared/pr-maintenance-contracts';

import * as z from 'zod';
import { watchPrMaintenancePolicySchema } from '../../../services/cloud-agent-next/src/shared/pr-maintenance-contracts';

export const pullRequestAutoFixSettingsSchema = z.strictObject({
  autoEnable: z.boolean(),
  model: watchPrMaintenancePolicySchema.shape.model,
  variant: watchPrMaintenancePolicySchema.shape.variant,
  categories: watchPrMaintenancePolicySchema.shape.categories,
  trustedBotLogins: watchPrMaintenancePolicySchema.shape.trustedBotLogins,
  automaticWritesConsent: watchPrMaintenancePolicySchema.shape.automaticWritesConsent,
  historyRewriteConsent: watchPrMaintenancePolicySchema.shape.historyRewriteConsent,
  noHardSpendCapConsent: watchPrMaintenancePolicySchema.shape.noHardSpendCapConsent,
});

export type PullRequestAutoFixSettings = z.infer<typeof pullRequestAutoFixSettingsSchema>;
