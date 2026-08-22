import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  type ChildSessionSheetMountState,
  closeChildSessionSheet,
  getChildSessionSheetState,
  openChildSessionSheet,
  releaseChildSessionSheet,
} from './child-session-sheet-state';

const emptyMount: ChildSessionSheetMountState = { sheet: null, visible: false };
const childA = { sessionId: 'child-a' as KiloSessionId, title: 'Subagent A' };
const childB = { sessionId: 'child-b' as KiloSessionId, title: 'Subagent B' };

describe('getChildSessionSheetState', () => {
  it('shows loading while hydration has not completed', () => {
    expect(getChildSessionSheetState({ status: 'loading' }, 0)).toBe('loading');
  });

  it('shows an empty state after successful hydration with no messages', () => {
    expect(
      getChildSessionSheetState(
        {
          status: 'ready',
          cursor: null,
          hasOlder: false,
          isLoadingOlder: false,
          olderError: null,
          omittedItemCount: 0,
        },
        0
      )
    ).toBe('empty');
  });

  it('shows an empty state when the session error is null', () => {
    expect(
      getChildSessionSheetState(
        {
          status: 'ready',
          cursor: null,
          hasOlder: false,
          isLoadingOlder: false,
          olderError: null,
          omittedItemCount: 0,
        },
        0,
        null
      )
    ).toBe('empty');
  });

  it('shows an error after failed hydration with no messages', () => {
    expect(getChildSessionSheetState({ status: 'error', message: 'Failed' }, 0)).toBe('error');
  });

  it('keeps rendering messages if a refresh fails', () => {
    expect(getChildSessionSheetState({ status: 'error', message: 'Failed' }, 1)).toBe('content');
  });

  it('shows an error for a runtime error with no messages and hydration ready', () => {
    expect(
      getChildSessionSheetState(
        {
          status: 'ready',
          cursor: null,
          hasOlder: false,
          isLoadingOlder: false,
          olderError: null,
          omittedItemCount: 0,
        },
        0,
        'Requests ending with a model turn are not supported.'
      )
    ).toBe('error');
  });

  it('keeps rendering messages when a runtime error exists', () => {
    expect(
      getChildSessionSheetState(
        {
          status: 'ready',
          cursor: null,
          hasOlder: false,
          isLoadingOlder: false,
          olderError: null,
          omittedItemCount: 0,
        },
        1,
        'Requests ending with a model turn are not supported.'
      )
    ).toBe('content');
  });
});

describe('openChildSessionSheet / closeChildSessionSheet', () => {
  it('open sets sheet and visible', () => {
    expect(openChildSessionSheet(emptyMount, childA)).toEqual({
      sheet: childA,
      visible: true,
    });
  });

  it('close keeps sheet mounted with visible false', () => {
    const open = openChildSessionSheet(emptyMount, childA);
    expect(closeChildSessionSheet(open)).toEqual({
      sheet: childA,
      visible: false,
    });
  });

  it('opening a different child replaces sheet and stays visible', () => {
    const openA = openChildSessionSheet(emptyMount, childA);
    expect(openChildSessionSheet(openA, childB)).toEqual({
      sheet: childB,
      visible: true,
    });
  });

  it('close when sheet is null is a no-op', () => {
    expect(closeChildSessionSheet(emptyMount)).toEqual({
      sheet: null,
      visible: false,
    });
  });
});

describe('releaseChildSessionSheet', () => {
  it('releases sheet identity after close', () => {
    const open = openChildSessionSheet(emptyMount, childA);
    const closed = closeChildSessionSheet(open);
    expect(releaseChildSessionSheet(closed)).toEqual({
      sheet: null,
      visible: false,
    });
  });

  it('is a no-op when sheet is already null', () => {
    expect(releaseChildSessionSheet(emptyMount)).toEqual({
      sheet: null,
      visible: false,
    });
  });

  it('never releases a visible sheet — a reopen before the scheduled release wins', () => {
    const closed = closeChildSessionSheet(openChildSessionSheet(emptyMount, childA));
    const reopened = openChildSessionSheet(closed, childB);
    expect(releaseChildSessionSheet(reopened)).toBe(reopened);
  });
});
