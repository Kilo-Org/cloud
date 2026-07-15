import { describe, expect, it, vi } from 'vitest';

import { INITIAL_LOCAL_SESSION_CONFIG_SELECTION } from './local-session-config-selection';
import { type LocalSessionConfigController } from './use-local-session-config-controller';
import {
  preservePromptOnClearFence,
  preservePromptOnRefreshCatalog,
} from './local-session-create-prompt-actions';

function makeMinimalController(
  partial: Partial<LocalSessionConfigController>
): LocalSessionConfigController {
  return {
    selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
    runtimesState: { data: undefined, isError: false, refetch: () => undefined },
    catalogState: { kind: 'idle' },
    onSelectFence: () => undefined,
    onClearFence: () => undefined,
    onSelectAgent: () => undefined,
    onSelectModel: () => undefined,
    onResetOverrides: () => undefined,
    refetchCatalog: () => undefined,
    ...partial,
  };
}

describe('preservePromptOnClearFence', () => {
  it('calls controller.onClearFence exactly once', () => {
    const onClearFence = vi.fn<() => void>();
    preservePromptOnClearFence({
      controller: makeMinimalController({ onClearFence }),
      promptRef: { current: 'untouched' },
    });
    expect(onClearFence).toHaveBeenCalledTimes(1);
  });

  it('never mutates the prompt ref content', () => {
    const onClearFence = vi.fn<() => void>();
    const promptRef = { current: 'live prompt' };
    preservePromptOnClearFence({
      controller: makeMinimalController({ onClearFence }),
      promptRef,
    });
    expect(promptRef.current).toBe('live prompt');
  });

  it('leaves an empty prompt empty', () => {
    const onClearFence = vi.fn<() => void>();
    const promptRef = { current: '' };
    preservePromptOnClearFence({
      controller: makeMinimalController({ onClearFence }),
      promptRef,
    });
    expect(promptRef.current).toBe('');
  });
});

describe('preservePromptOnRefreshCatalog', () => {
  it('invokes both refetchCatalog and onResetOverrides', () => {
    const refetchCatalog = vi.fn<() => void>();
    const onResetOverrides = vi.fn<() => void>();
    preservePromptOnRefreshCatalog({
      refetchCatalog,
      onResetOverrides,
      promptRef: { current: 'still here' },
    });
    expect(refetchCatalog).toHaveBeenCalledTimes(1);
    expect(onResetOverrides).toHaveBeenCalledTimes(1);
  });

  it('never mutates the prompt ref content', () => {
    const refetchCatalog = vi.fn<() => void>();
    const onResetOverrides = vi.fn<() => void>();
    const promptRef = { current: 'live prompt' };
    preservePromptOnRefreshCatalog({ refetchCatalog, onResetOverrides, promptRef });
    expect(promptRef.current).toBe('live prompt');
  });
});
