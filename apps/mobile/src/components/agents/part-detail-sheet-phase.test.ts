import { describe, expect, it } from 'vitest';

import { isSheetVisible, presentedPartId, reducePartDetailPhase } from './part-detail-sheet-phase';

const request = (partId: string, keyboardVisible = false) =>
  ({ type: 'request', partId, keyboardVisible }) as const;

describe('reducePartDetailPhase', () => {
  it('defers a request until the keyboard hides', () => {
    const deferred = reducePartDetailPhase({ kind: 'closed' }, request('bash-1', true));

    expect(deferred).toEqual({ kind: 'deferred', partId: 'bash-1' });
    expect(presentedPartId(deferred)).toBeNull();
    expect(isSheetVisible(deferred)).toBe(false);
    expect(isSheetVisible(reducePartDetailPhase(deferred, { type: 'keyboard-hidden' }))).toBe(true);
  });

  it('a request during a dismissal presents once the dismissal settles, and a stale report is ignored', () => {
    const presented = reducePartDetailPhase({ kind: 'closed' }, request('bash-1'));
    const dismissing = reducePartDetailPhase(presented, { type: 'close' });
    const queued = reducePartDetailPhase(dismissing, request('bash-2'));

    expect(queued).toEqual({ kind: 'dismissing', partId: 'bash-1', nextPartId: 'bash-2' });
    // The leaving part stays on screen until the native sheet reports it.
    expect(presentedPartId(queued)).toBe('bash-1');

    // A report for another occurrence must not settle this one.
    expect(reducePartDetailPhase(queued, { type: 'dismissal-settled', partId: 'bash-0' })).toBe(
      queued
    );

    const settled = reducePartDetailPhase(queued, { type: 'dismissal-settled', partId: 'bash-1' });

    expect(settled).toEqual({ kind: 'presented', partId: 'bash-2' });
    expect(presentedPartId(settled)).toBe('bash-2');
    expect(isSheetVisible(settled)).toBe(true);
    // A dismissing phase still renders the leaving part but is no longer presented.
    expect(presentedPartId(queued)).toBe('bash-1');
    expect(isSheetVisible(queued)).toBe(false);
  });

  it('closes when the settled dismissal has nothing queued', () => {
    const dismissed = reducePartDetailPhase(
      { kind: 'dismissing', partId: 'bash-1', nextPartId: null },
      { type: 'dismissal-settled', partId: 'bash-1' }
    );

    expect(dismissed).toEqual({ kind: 'closed' });
    expect(isSheetVisible(dismissed)).toBe(false);
  });
});
