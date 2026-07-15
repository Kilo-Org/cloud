import { describe, expect, it } from 'vitest';

import { type SessionContextInfo } from '@/lib/session-context-info';

import { getContextSheetMountState } from './context-usage-display';

const currentInfo: SessionContextInfo = {
  contextTokens: 32_418,
  providerID: 'kilo',
  modelID: 'anthropic/claude-sonnet-4',
  contextWindow: 200_000,
  percentage: 16,
};

describe('getContextSheetMountState', () => {
  it('unmounts when there is no context info regardless of open state', () => {
    expect(getContextSheetMountState(undefined, null, 'current-session')).toEqual({
      mounted: false,
    });
    expect(
      getContextSheetMountState(
        undefined,
        {
          sessionId: 'current-session',
          providerID: currentInfo.providerID,
          modelID: currentInfo.modelID,
        },
        'current-session'
      )
    ).toEqual({ mounted: false });
  });

  it('mounts visible when context info exists and its identity is open', () => {
    const result = getContextSheetMountState(
      currentInfo,
      {
        sessionId: 'current-session',
        providerID: currentInfo.providerID,
        modelID: currentInfo.modelID,
      },
      'current-session'
    );

    expect(result).toEqual({ mounted: true, visible: true, info: currentInfo });
  });

  it('mounts hidden when context info exists but the sheet is closed', () => {
    const result = getContextSheetMountState(currentInfo, null, 'current-session');

    expect(result).toEqual({ mounted: true, visible: false, info: currentInfo });
  });

  it('does not reopen after the session changes', () => {
    expect(
      getContextSheetMountState(
        currentInfo,
        {
          sessionId: 'previous-session',
          providerID: currentInfo.providerID,
          modelID: currentInfo.modelID,
        },
        'current-session'
      )
    ).toEqual({ mounted: true, visible: false, info: currentInfo });
  });

  it('does not reopen when the runtime model identity changes', () => {
    const nextInfo = { ...currentInfo, modelID: 'next-model' };

    expect(
      getContextSheetMountState(
        nextInfo,
        {
          sessionId: 'current-session',
          providerID: 'kilo',
          modelID: 'previous-model',
        },
        'current-session'
      )
    ).toEqual({ mounted: true, visible: false, info: nextInfo });
  });
});
