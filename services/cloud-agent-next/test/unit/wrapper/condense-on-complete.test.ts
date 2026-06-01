import { describe, expect, it, vi } from 'vitest';

import { runCondenseOnComplete } from '../../../wrapper/src/condense-on-complete.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

describe('runCondenseOnComplete', () => {
  it('uses the dedicated summarize endpoint with the active model', async () => {
    const kiloClient = {
      summarizeSession: vi.fn().mockResolvedValue(true),
      abortSession: vi.fn().mockResolvedValue(true),
    } as unknown as WrapperKiloClient;
    const onEvent = vi.fn();
    const expectCompletion = vi.fn();
    const waitForCompletion = vi.fn().mockResolvedValue(undefined);
    const wasAborted = vi.fn().mockReturnValue(false);

    const result = await runCondenseOnComplete({
      workspacePath: '/workspace',
      kiloSessionId: 'kilo_sess',
      model: 'anthropic/claude-sonnet-4-20250514',
      onEvent,
      kiloClient,
      expectCompletion,
      waitForCompletion,
      wasAborted,
      timeoutMs: 100,
    });

    expect(result).toEqual({ wasAborted: false, success: true });
    expect(expectCompletion).toHaveBeenCalledOnce();
    expect(kiloClient.summarizeSession).toHaveBeenCalledWith({
      sessionId: 'kilo_sess',
      model: { modelID: 'anthropic/claude-sonnet-4-20250514' },
      auto: true,
    });
  });
});
