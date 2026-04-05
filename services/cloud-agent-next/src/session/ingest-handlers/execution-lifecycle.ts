export type ExecutionStatus = 'completed' | 'failed' | 'interrupted';

export type ExecutionLifecycleContext = {
  updateExecutionStatus: (
    executionId: string,
    status: ExecutionStatus,
    error?: string,
    gateResult?: 'pass' | 'fail'
  ) => Promise<void>;
  clearActiveExecution: () => Promise<void>;
  getActiveExecutionId: () => Promise<string | null>;
  logger: { info: (msg: string, data?: object) => void };
};

/**
 * Handle execution completion - update status and clear active execution.
 */
export async function handleExecutionComplete(
  executionId: string,
  status: ExecutionStatus,
  ctx: ExecutionLifecycleContext,
  error?: string,
  gateResult?: 'pass' | 'fail'
): Promise<void> {
  ctx.logger.info('Execution complete', { executionId, status, error, gateResult });

  // Snapshot active execution before updateStatus clears it — we need this to
  // decide whether to clean up afterward.
  const wasActive = (await ctx.getActiveExecutionId()) === executionId;

  // Update the execution status and completedAt in storage
  await ctx.updateExecutionStatus(executionId, status, error, gateResult);

  // Clear active execution only if this was the active execution.
  // updateStatus already clears active_execution_id internally when it matches,
  // so the clear here is a safety net. We skip when this execution wasn't active
  // to avoid clobbering a newer execution that started in between.
  if (wasActive) {
    const activeId = await ctx.getActiveExecutionId();
    if (activeId === executionId) {
      await ctx.clearActiveExecution();
    }
  }
}
