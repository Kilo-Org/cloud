import { type SafeFailureProjection } from './safe-failure-projection.js';
import type { CustomerBillingFailure } from '@kilocode/session-ingest-contracts';

export type CloudMessageFailedPayload = {
  messageId: string;
  status: 'failed' | 'interrupted';
  delivery: 'sent' | 'queued';
  accepted: boolean;
  completionSource?: string;
  reason?: string;
  attempts?: number;
  error?: string;
  failure?: SafeFailureProjection;
  billingFailure?: CustomerBillingFailure;
};
