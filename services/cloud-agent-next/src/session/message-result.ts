import type {
  SessionMessageCompletionSource,
  SessionMessageFailureCode,
  SessionMessageFailureStage,
} from './session-message-state.js';
import type { SafeFailureProjection } from './safe-failure-projection.js';

export type SafeMessageResultFailure = SafeFailureProjection & {
  stage: SessionMessageFailureStage;
  code: SessionMessageFailureCode;
  retryable: boolean;
};

export type SafeMessageResultPreparation = {
  status: 'running' | 'completed' | 'failed';
  failedStepLabel?: string;
  reason?: string;
};

export type SafeMessageResult = {
  messageId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  queuedAt?: number;
  acceptedAt?: number;
  terminalAt?: number;
  completionSource?: SessionMessageCompletionSource;
  failure?: SafeMessageResultFailure;
  gateResult?: 'pass' | 'fail';
  branch?: string;
  preparation?: SafeMessageResultPreparation;
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
