import { type SafeFailureProjection } from './safe-failure-projection.js';

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
};
