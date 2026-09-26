import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLOSED_SESSION_PREVIEW,
  closeSessionPreview,
  closeSessionPreviewStore,
  getSessionPreviewSnapshot,
  openSessionPreview,
  openSessionPreviewStore,
  releaseSessionPreview,
  releaseSessionPreviewStore,
  type SessionPreviewTarget,
  subscribeSessionPreview,
} from './session-preview-state';

const targetA: SessionPreviewTarget = {
  sessionId: 'ses-a',
  title: 'Fix login',
  initialRenameValue: 'Fix login',
  live: false,
  statusKind: null,
  needsInput: false,
  totalCostMicrodollars: null,
};

const targetB: SessionPreviewTarget = {
  ...targetA,
  sessionId: 'ses-b',
  title: 'Ship the preview',
  live: true,
  statusKind: 'running',
  totalCostMicrodollars: 12_345,
};

describe('openSessionPreview / closeSessionPreview', () => {
  it('open sets the target and makes the preview visible', () => {
    expect(openSessionPreview(CLOSED_SESSION_PREVIEW, targetA)).toEqual({
      target: targetA,
      visible: true,
    });
  });

  it('opening a different session replaces the target and stays visible', () => {
    const open = openSessionPreview(CLOSED_SESSION_PREVIEW, targetA);
    expect(openSessionPreview(open, targetB)).toEqual({ target: targetB, visible: true });
  });

  it('close keeps the target mounted with visible false', () => {
    const open = openSessionPreview(CLOSED_SESSION_PREVIEW, targetA);
    expect(closeSessionPreview(open)).toEqual({ target: targetA, visible: false });
  });

  it('close on an already-closed state is a no-op that keeps identity', () => {
    const closed = closeSessionPreview(openSessionPreview(CLOSED_SESSION_PREVIEW, targetA));
    expect(closeSessionPreview(closed)).toBe(closed);
  });
});

describe('releaseSessionPreview', () => {
  it('releases the target after close', () => {
    const closed = closeSessionPreview(openSessionPreview(CLOSED_SESSION_PREVIEW, targetA));
    expect(releaseSessionPreview(closed)).toEqual({ target: null, visible: false });
  });

  it('is a no-op when there is no target', () => {
    expect(releaseSessionPreview(CLOSED_SESSION_PREVIEW)).toBe(CLOSED_SESSION_PREVIEW);
  });

  it('never releases a visible preview — a reopen before the scheduled release wins', () => {
    const closed = closeSessionPreview(openSessionPreview(CLOSED_SESSION_PREVIEW, targetA));
    const reopened = openSessionPreview(closed, targetB);
    expect(releaseSessionPreview(reopened)).toBe(reopened);
  });
});

describe('session preview store', () => {
  beforeEach(() => {
    closeSessionPreviewStore();
    releaseSessionPreviewStore();
  });

  it('returns a stable snapshot while the state is unchanged', () => {
    const first = getSessionPreviewSnapshot();
    const second = getSessionPreviewSnapshot();
    expect(first).toBe(second);
  });

  it('replaces the snapshot only when the state changes', () => {
    const before = getSessionPreviewSnapshot();
    openSessionPreviewStore(targetA);
    const afterOpen = getSessionPreviewSnapshot();
    expect(afterOpen).not.toBe(before);
    expect(afterOpen).toEqual({ target: targetA, visible: true });
    expect(getSessionPreviewSnapshot()).toBe(afterOpen);
  });

  it('notifies subscribers on open, close and release', () => {
    const listener = vi.fn(() => undefined);
    const unsubscribe = subscribeSessionPreview(listener);

    openSessionPreviewStore(targetA);
    expect(listener).toHaveBeenCalledTimes(1);

    closeSessionPreviewStore();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSessionPreviewSnapshot()).toEqual({ target: targetA, visible: false });

    releaseSessionPreviewStore();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getSessionPreviewSnapshot()).toEqual({ target: null, visible: false });

    unsubscribe();
    openSessionPreviewStore(targetB);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not notify when a store transition is a no-op', () => {
    const listener = vi.fn(() => undefined);
    const unsubscribe = subscribeSessionPreview(listener);

    closeSessionPreviewStore();
    releaseSessionPreviewStore();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('keeps the reopened target when a scheduled release lands after reopen', () => {
    openSessionPreviewStore(targetA);
    closeSessionPreviewStore();
    openSessionPreviewStore(targetB);
    releaseSessionPreviewStore();

    expect(getSessionPreviewSnapshot()).toEqual({ target: targetB, visible: true });
  });
});
