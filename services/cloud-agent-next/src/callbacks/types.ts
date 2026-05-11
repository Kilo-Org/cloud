export type CallbackTarget = {
  url: string;
  headers?: Record<string, string>;
};

export type ExecutionCallbackPayload = {
  sessionId: string;
  cloudAgentSessionId: string;
  executionId: string;
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
};

export type CallbackJob = {
  target: CallbackTarget;
  payload: ExecutionCallbackPayload;
};
