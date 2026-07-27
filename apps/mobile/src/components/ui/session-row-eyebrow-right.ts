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
 * Plus an independent `showPlatformIcon` flag: true when a platform icon
 * was provided AND the kind is not `needs-input` (attention treatment
 * keeps priority and suppresses the icon).
 *
 * Home and the Agents list both call this, but only the Agents tray
 * opts into `metaWhileLive`. Keeping the rule here makes it testable
 * without a render tree.
 */
export type SessionRowEyebrowRight =
  | { kind: 'needs-input'; showPlatformIcon: boolean }
  | { kind: 'live-and-meta'; showPlatformIcon: boolean }
  | { kind: 'live'; showPlatformIcon: boolean }
  | { kind: 'meta'; showPlatformIcon: boolean }
  | { kind: 'none'; showPlatformIcon: boolean };

export function selectSessionRowEyebrowRight(inputs: {
  needsInput: boolean;
  live: boolean;
  hasMeta: boolean;
  metaWhileLive: boolean;
  /** When true, a platform icon node is available to render. */
  hasPlatformIcon?: boolean;
}): SessionRowEyebrowRight {
  const { needsInput, live, hasMeta, metaWhileLive, hasPlatformIcon = false } = inputs;

  if (needsInput) {
    // Attention treatment keeps priority; icon is always suppressed.
    return { kind: 'needs-input', showPlatformIcon: false };
  }
  if (live && hasMeta && metaWhileLive) {
    return { kind: 'live-and-meta', showPlatformIcon: hasPlatformIcon };
  }
  if (live) {
    return { kind: 'live', showPlatformIcon: hasPlatformIcon };
  }
  if (hasMeta) {
    return { kind: 'meta', showPlatformIcon: hasPlatformIcon };
  }
  return { kind: 'none', showPlatformIcon: hasPlatformIcon };
}
