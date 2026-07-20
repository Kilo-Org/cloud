import { parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * Speech-friendly relative-time formatter.
 *
 * `timeAgo` (`@/lib/utils`) produces abbreviated strings like `"5m ago"`,
 * `"1h ago"`, `"3d ago"`, `"1mo ago"`, `"2y ago"`, or `"just now"`. When
 * the row renders those through `formatMeta` they are uppercased
 * (`"5M AGO"`), which VoiceOver reads letter-by-letter. This helper
 * expands every unit `timeAgo` emits into a form VoiceOver reads as words,
 * with singular/plural handled, and leaves `"just now"` unchanged.
 *
 * Inputs that don't match a known unit pass through unchanged so a future
 * `timeAgo` unit added without updating this helper doesn't get silently
 * mangled — the worst case is the same letter-by-letter reading the
 * uppercased form already has.
 */
export function formatSpokenTimeAgo(timestamp: string): string {
  const raw = timeAgo(parseTimestamp(timestamp));
  const match = /^(\d+)([a-z]+)\s+ago$/.exec(raw);
  if (!match) {
    // "just now" or any future-unrecognized form
    return raw;
  }
  const n = Number(match[1]);
  const unit = match[2];
  const singular: Record<string, string> = {
    m: 'minute',
    h: 'hour',
    d: 'day',
    mo: 'month',
    y: 'year',
  };
  const word = unit ? singular[unit] : undefined;
  if (!word) {
    // Unrecognized unit — pass through so a future `timeAgo` unit added
    // without updating this helper doesn't get silently mangled.
    return raw;
  }
  return `${n} ${n === 1 ? word : `${word}s`} ago`;
}

type SessionRowAccessibilityLabelInputs = {
  /** Row title, always present (e.g. "Untitled session" fallback). */
  title: string;
  /** True when the row's right eyebrow renders the `NEEDS INPUT` state. */
  needsInput: boolean;
  /**
   * Left-eyebrow badge text, always visible (e.g. "CLI", "VSCODE", "LIVE",
   * "CLOUD AGENT"). Pass an empty string only as a defensive fallback —
   * the row always supplies a non-empty badge today.
   */
  badge: string;
  /**
   * Right-eyebrow meta text in spoken form (typically
   * `formatSpokenTimeAgo` output). Pass `null`/`undefined` when the row
   * does NOT render meta (needs-input eyebrow, or bare-live eyebrow with
   * no meta).
   */
  meta?: string | null;
};

/**
 * Compose the screen-reader label for a `SessionRow`, mirroring its visible
 * content in the order the row renders parts: title, then `needs input`
 * (only when the needs-input eyebrow is shown), then the always-visible
 * left-eyebrow badge, then the meta text (only when the row visibly
 * renders meta). Empty parts are skipped; the order is fixed.
 *
 * Three exclusive variants, aligned with `selectSessionRowEyebrowRight`:
 *   - **needs-input variant**  (`needs-input` eyebrow):
 *       `"<title>, needs input, <badge>"` — meta is NOT rendered, so it is
 *       omitted. The left-eyebrow badge is always included.
 *   - **visible-meta variant** (`live-and-meta` / `meta` eyebrow):
 *       `"<title>, <badge>, <meta>"` — meta is included in spoken form.
 *   - **bare-live variant**   (`live` eyebrow):
 *       `"<title>, <badge>"` — no meta text.
 *
 * Extends the `, needs input` pattern from PR #4605 (commit 635eaddc6)
 * without replacing it.
 */
export function sessionRowAccessibilityLabel({
  title,
  needsInput,
  badge,
  meta,
}: SessionRowAccessibilityLabelInputs): string {
  const parts: string[] = [title];
  if (needsInput) {
    parts.push('needs input');
  }
  if (badge) {
    parts.push(badge);
  }
  if (meta) {
    parts.push(meta);
  }
  return parts.join(', ');
}
