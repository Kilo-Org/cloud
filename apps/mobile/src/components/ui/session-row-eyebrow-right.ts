/**
 * Pure decision for the right-hand side of `SessionRow`'s eyebrow row.
 *
 * The eyebrow can show at most one of:
 *  - a pulsing warn dot + `NEEDS INPUT` (highest priority)
 *  - a `metaWhileLive` composition: live dot + meta text
 *  - a live dot alone (default)
 *  - a meta text alone
 *  - nothing
 *
 * Home and the Agents list both call this, but only the Agents tray
 * opts into `metaWhileLive`. Keeping the rule here makes it testable
 * without a render tree.
 */
export type SessionRowEyebrowRight =
  | { kind: 'needs-input' }
  | { kind: 'live-and-meta' }
  | { kind: 'live' }
  | { kind: 'meta' }
  | { kind: 'none' };

export function selectSessionRowEyebrowRight(inputs: {
  needsInput: boolean;
  live: boolean;
  hasMeta: boolean;
  metaWhileLive: boolean;
}): SessionRowEyebrowRight {
  const { needsInput, live, hasMeta, metaWhileLive } = inputs;

  if (needsInput) {
    return { kind: 'needs-input' };
  }
  if (live && hasMeta && metaWhileLive) {
    return { kind: 'live-and-meta' };
  }
  if (live) {
    return { kind: 'live' };
  }
  if (hasMeta) {
    return { kind: 'meta' };
  }
  return { kind: 'none' };
}
