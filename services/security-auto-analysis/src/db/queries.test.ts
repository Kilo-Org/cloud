import { describe, expect, it, vi } from 'vitest';
import { resolveSecurityAgentModels } from '../types.js';
import { parseSecurityConfig, reconcileStaleAnalysisQueueRows } from './queries.js';

describe('parseSecurityConfig', () => {
  it('preserves legacy model fallback when phase-specific models are absent', () => {
    const config = parseSecurityConfig({ model_slug: 'legacy/model' });

    expect(resolveSecurityAgentModels(config)).toEqual({
      triageModel: 'legacy/model',
      analysisModel: 'legacy/model',
    });
  });
});

describe('reconcileStaleAnalysisQueueRows', () => {
  it('reports requeued stale pending rows and failed stale running rows', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'pending-row' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'running-row' }, { id: 'running-row-2' }] });

    await expect(reconcileStaleAnalysisQueueRows({ execute } as never)).resolves.toEqual({
      requeuedPendingCount: 1,
      failedRunningCount: 2,
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('leaves fresh rows untouched when reconciliation queries return no stale rows', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(reconcileStaleAnalysisQueueRows({ execute } as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });
  });
});
