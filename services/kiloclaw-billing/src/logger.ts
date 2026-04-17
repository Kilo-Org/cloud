import { WorkersLogger } from 'workers-tagged-logger';

import type { BillingSweepKind } from './types.js';
import type { BillingCorrelationContext } from '@kilocode/worker-utils/kiloclaw-billing-observability';

export type BillingLogFieldValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | { [key: string]: BillingLogFieldValue }
  | BillingLogFieldValue[];

export type BillingLogFields = {
  [key: string]: BillingLogFieldValue;
};

export type BillingLogTags = BillingCorrelationContext & {
  billingComponent?: 'worker' | 'side_effects' | 'kiloclaw_platform';
  billingSweep?: BillingSweepKind;
  source?: string;
  event?: string;
  outcome?: 'started' | 'completed' | 'failed' | 'retry' | 'discarded';
  userId?: string;
  instanceId?: string;
  stripeSubscriptionId?: string;
  kiloclawSubscriptionId?: string;
  action?: string;
  statusCode?: number;
  durationMs?: number;
  willGoToDlq?: boolean;
};

export const logger = new WorkersLogger<BillingLogTags>({
  minimumLogLevel: 'debug',
  debug: false,
});

export { withLogTags, WithLogTags } from 'workers-tagged-logger';
