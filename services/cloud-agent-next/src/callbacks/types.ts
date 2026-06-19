import type { CloudAgentFailureStage } from '@kilocode/worker-utils/cloud-agent-failure';
import type { ClientError } from '@kilocode/worker-utils/client-error';
import type { SafeFailureProjection } from '../session/safe-failure-projection.js';
import type { ModelNotFoundRuntimeDiagnostics } from '../shared/runtime-model-diagnostics.js';

export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

export type CallbackTextTruncation = {
  originalUtf8ByteLength: number;
  retainedUtf8ByteLength: number;
};

export type ExecutionCallbackPayload = {
  sessionId: string;
  cloudAgentSessionId: string;
  /** Deprecated compatibility alias for messageId. */
  executionId?: string;
  /** Message ID correlated with this execution. */
  messageId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  failure?: SafeFailureProjection;
  modelNotFoundRuntimeDiagnostics?: ModelNotFoundRuntimeDiagnostics;
  failureStage?: CloudAgentFailureStage;
  clientError?: ClientError;
  /** Present when errorMessage was shortened to fit the callback queue. */
  errorMessageTruncation?: CallbackTextTruncation;
  lastSeenBranch?: string;
  kiloSessionId?: string;
  /** Gate result reported by the agent when gate_threshold is active */
  gateResult?: 'pass' | 'fail';
  /**
   * Concatenated text of the latest assistant message at the time of callback.
   * Undefined when no assistant message has been recorded yet.
   */
  lastAssistantMessageText?: string;
  /** Present when lastAssistantMessageText was omitted to fit the callback queue. */
  lastAssistantMessageTextTruncation?: CallbackTextTruncation;
  /**
   * Deterministic idempotency key based on messageId.
   * Receivers can use this to safely deduplicate retried callbacks after a
   * DO crash between queue.send() and callbackEnqueuedAt persistence.
   */
  idempotencyKey?: string;
};

export type CallbackJob = {
  target: CallbackTarget;
  payload: ExecutionCallbackPayload;
};
