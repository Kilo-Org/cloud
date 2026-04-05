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
};

export type CallbackJob = {
  target: CallbackTarget;
  payload: ExecutionCallbackPayload;
};
