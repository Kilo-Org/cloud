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
 * Plus an independent `showPlatformIcon` flag. The platform glyph renders
 * only when NO state glyph is drawn: needs-input suppresses it (attention
 * keeps priority), and the live kinds draw the session's status glyph —
 * the one mark that names the state — so a platform-origin glyph beside it
 * reads as a stray second mark crowding the meta. Kinds `meta`/`none`
 * (no status glyph) show the icon iff one was provided.
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
