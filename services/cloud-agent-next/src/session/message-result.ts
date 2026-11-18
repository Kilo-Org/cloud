import { type SessionMessageCompletionSource } from './session-message-state.js';
import { type SafeFailureProjection } from './safe-failure-projection.js';

export type SafeMessageResult = {
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  queuedAt?: number;
  acceptedAt?: number;
  terminalAt?: number;
  completionSource?: SessionMessageCompletionSource;
  failure?: SafeFailureProjection & { retryable: boolean };
  gateResult?: 'pass' | 'fail';
};

export type SafeMessageResultResponse = SafeMessageResult & {
  cloudAgentSessionId: string;
  assistant?: {
    messageId: string;
    text?: string;
  };
};

export type MessageResultRPCResponse =
  | { type: 'session-not-found' }
  | { type: 'message-not-found' }
  | { type: 'state-invalid' }
  | { type: 'found'; result: SafeMessageResultResponse };
