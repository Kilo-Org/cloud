export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
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
  lastSeenBranch?: string;
  kiloSessionId?: string;
  /** Gate result reported by the agent when gate_threshold is active */
  gateResult?: 'pass' | 'fail';
  /**
   * Concatenated text of the latest assistant message at the time of callback.
   * Undefined when no assistant message has been recorded yet.
   */
  lastAssistantMessageText?: string;
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
