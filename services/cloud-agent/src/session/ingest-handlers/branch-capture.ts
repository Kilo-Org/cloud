import type { CompleteEventData } from '../../shared/protocol.js';

export type BranchCaptureContext = {
  updateUpstreamBranch: (branch: string) => Promise<void>;
  logger: { info: (msg: string, data?: object) => void };
};

/**
 * Extract and persist branch from complete event data.
 */
export async function handleBranchCapture(
  data: CompleteEventData,
  ctx: BranchCaptureContext
): Promise<void> {
  if (!data.currentBranch) return;

  await ctx.updateUpstreamBranch(data.currentBranch);
  ctx.logger.info('Captured branch from complete event', { branch: data.currentBranch });
}
