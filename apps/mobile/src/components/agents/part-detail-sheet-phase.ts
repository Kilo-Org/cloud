/**
 * The part-detail host's presentation phases, split out of the component so the
 * transitions a native report drives can be tested without mounting the sheet.
 */

/** What the part-detail host is doing with its one native sheet. */
export type PartDetailPhase =
  | { readonly kind: 'closed' }
  | { readonly kind: 'deferred'; readonly partId: string }
  | { readonly kind: 'presented'; readonly partId: string }
  | {
      readonly kind: 'dismissing';
      readonly partId: string;
      /** The part a request made during the dismissal presents once it settles. */
      readonly nextPartId: string | null;
    };

export type PartDetailEvent =
  | { readonly type: 'request'; readonly partId: string; readonly keyboardVisible: boolean }
  | { readonly type: 'keyboard-hidden' }
  | { readonly type: 'close' }
  | { readonly type: 'dismissal-settled'; readonly partId: string };

export function reducePartDetailPhase(
  phase: PartDetailPhase,
  event: PartDetailEvent
): PartDetailPhase {
  switch (event.type) {
    case 'request': {
      if (phase.kind === 'dismissing') {
        return { ...phase, nextPartId: event.partId };
      }
      if (event.keyboardVisible) {
        return { kind: 'deferred', partId: event.partId };
      }
      return { kind: 'presented', partId: event.partId };
    }
    case 'keyboard-hidden': {
      return phase.kind === 'deferred' ? { kind: 'presented', partId: phase.partId } : phase;
    }
    case 'close': {
      return phase.kind === 'presented'
        ? { kind: 'dismissing', partId: phase.partId, nextPartId: null }
        : phase;
    }
    case 'dismissal-settled': {
      // A report for a presentation that is not on screen is ignored; the live one
      // settles, whether the close that precedes it was already reduced or is still
      // queued behind the report.
      if (phase.kind === 'closed' || phase.kind === 'deferred' || phase.partId !== event.partId) {
        return phase;
      }
      return settlePresentation(phase);
    }
    default: {
      return phase;
    }
  }
}

/**
 * Settle the presentation the host is showing, whatever edge reported it: a
 * dismissal report can arrive before the close it belongs to has been reduced, and
 * a self-dismissal the native sheet never completed leaves only this edge.
 */
export function settlePresentation(phase: PartDetailPhase): PartDetailPhase {
  if (phase.kind === 'dismissing') {
    return phase.nextPartId === null
      ? { kind: 'closed' }
      : { kind: 'presented', partId: phase.nextPartId };
  }
  return phase.kind === 'presented' ? { kind: 'closed' } : phase;
}

/** The part the sheet renders, or null when it renders nothing. */
export function presentedPartId(phase: PartDetailPhase): string | null {
  return phase.kind === 'presented' || phase.kind === 'dismissing' ? phase.partId : null;
}

/** Whether the host asks the native sheet to stay presented. False while it dismisses. */
export function isSheetVisible(phase: PartDetailPhase): boolean {
  return phase.kind === 'presented';
}
