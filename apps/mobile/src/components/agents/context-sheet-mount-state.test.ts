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
  it('opens permission controls before the first usage report and stays open when usage arrives', () => {
    const identity = { sessionId: 'current-session' };
    const session = { sessionId: 'current-session', autoApproveAvailable: true };
    expect(getContextSheetMountState(undefined, identity, session)).toEqual({
      mounted: true,
      visible: true,
      info: undefined,
    });
    expect(getContextSheetMountState(currentInfo, identity, session)).toEqual({
      mounted: true,
      visible: true,
      info: currentInfo,
    });
  });

  it('keeps the no-usage sheet mounted for dismissal without carrying it to another session', () => {
    const session = { sessionId: 'current-session', autoApproveAvailable: true };
    expect(getContextSheetMountState(undefined, null, session)).toEqual({
      mounted: true,
      visible: false,
      info: undefined,
    });
    expect(
      getContextSheetMountState(undefined, { sessionId: 'previous-session' }, session)
    ).toEqual({ mounted: true, visible: false, info: undefined });
  });

  it('unmounts the no-usage sheet when permission controls become unavailable', () => {
    expect(
      getContextSheetMountState(
        undefined,
        { sessionId: 'current-session' },
        { sessionId: 'current-session', autoApproveAvailable: false }
      )
    ).toEqual({ mounted: false });
  });

  it('unmounts when there is no context info regardless of open state', () => {
    expect(getContextSheetMountState(undefined, null, { sessionId: 'current-session' })).toEqual({
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
        { sessionId: 'current-session' }
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
      { sessionId: 'current-session' }
    );

    expect(result).toEqual({ mounted: true, visible: true, info: currentInfo });
  });

  it('mounts hidden when context info exists but the sheet is closed', () => {
    const result = getContextSheetMountState(currentInfo, null, { sessionId: 'current-session' });

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
        { sessionId: 'current-session' }
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
        { sessionId: 'current-session' }
      )
    ).toEqual({ mounted: true, visible: false, info: nextInfo });
  });
});
