/**
 * Pure decision for the right-hand side of `SessionRow`'s eyebrow row.
 *
 * The eyebrow can show at most one of:
 *  - a pulsing warn dot + `NEEDS INPUT` (highest priority)
 *  - a Clock glyph + `SCHEDULED` (with the wake time when one is known)
 *  - a `metaWhileLive` composition: live dot + meta text
 *  - a live dot alone (default)
 *  - a meta text alone
 *  - nothing
 *
 * Plus an independent `showPlatformIcon` flag. The platform glyph renders
 * only when NO state glyph is drawn: needs-input suppresses it (attention
 * keeps priority), scheduled suppresses it (the Clock names the state), and
 * the live kinds draw the session's status glyph — the one mark that names
 * the state — so a platform-origin glyph beside it reads as a stray second
 * mark crowding the meta. Kinds `meta`/`none` (no status glyph) show the
 * icon iff one was provided.
 *
 * Home and the Agents list both call this, but only the Agents tray
 * opts into `metaWhileLive`. Keeping the rule here makes it testable
 * without a render tree.
 */
export type SessionRowEyebrowRight =
  | { kind: 'needs-input'; showPlatformIcon: boolean }
  | { kind: 'scheduled'; showPlatformIcon: boolean }
  | { kind: 'live-and-meta'; showPlatformIcon: boolean }
  | { kind: 'live'; showPlatformIcon: boolean }
  | { kind: 'meta'; showPlatformIcon: boolean }
  | { kind: 'none'; showPlatformIcon: boolean };

export function selectSessionRowEyebrowRight(inputs: {
  needsInput: boolean;
  /**
   * The row's status is `scheduled`. Ranks directly below needs-input and
   * above every live/meta kind, and keys off the status rather than the
   * `live` flag so a stored history row reads `SCHEDULED` too.
   */
  scheduled?: boolean;
  live: boolean;
  hasMeta: boolean;
  metaWhileLive: boolean;
  /** When true, a platform icon node is available to render. */
  hasPlatformIcon?: boolean;
}): SessionRowEyebrowRight {
  const {
    needsInput,
    scheduled = false,
    live,
    hasMeta,
    metaWhileLive,
    hasPlatformIcon = false,
  } = inputs;

  if (needsInput) {
    // Attention treatment keeps priority; icon is always suppressed.
    return { kind: 'needs-input', showPlatformIcon: false };
  }
  if (scheduled) {
    // The Clock glyph and the SCHEDULED label own the cluster; meta text and
    // the platform glyph are suppressed, exactly as on needs-input.
    return { kind: 'scheduled', showPlatformIcon: false };
  }
  if (live && hasMeta && metaWhileLive) {
    // The status glyph draws here; a platform glyph beside it would read as
    // a stray second mark in the cluster.
    return { kind: 'live-and-meta', showPlatformIcon: false };
  }
  if (live) {
    return { kind: 'live', showPlatformIcon: false };
  }
  if (hasMeta) {
    return { kind: 'meta', showPlatformIcon: hasPlatformIcon };
  }
  return { kind: 'none', showPlatformIcon: hasPlatformIcon };
}
