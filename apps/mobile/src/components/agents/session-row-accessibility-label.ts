import { platformLabel } from '@/lib/platform-label';
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

/**
 * Speech-friendly cost formatter.
 *
 * Mirrors the visible cost segment (`formatSessionTotalCost`) but in a form
 * VoiceOver reads as words rather than the literal `"$0.12"`. Inputs that
 * are `null`, `undefined`, zero, or not finite collapse to `null` so the
 * caller can omit the cost phrase from the spoken meta entirely (matching
 * the visible surface, which omits cost when there is none).
 *
 * Spoken and visible agree on the omit band (1..49 µ$ → null). Branching
 * uses the same half-cent threshold as the visible formatter (`>= 5000` µ$):
 *   - `>= 5000` µ$: whole-cent rounding, then
 *       under $1 → `"<N> cent(s)"`
 *       $1+     → `"<N> dollar(s)"` plus `" <N> cent(s)"` only when the
 *                 cents component is non-zero
 *   - below 5000 µ$: fractional cents to 2 decimal places with trailing
 *     zeros trimmed (e.g. `0.4 cents` for 4000 µ$), always plural `cents`.
 *     Below half a cent the spoken form is the exact humanized reading of
 *     the visible 4-decimal string.
 */
export function formatSpokenCost(microdollars: number | null | undefined): string | null {
  if (microdollars === null || microdollars === undefined) {
    return null;
  }
  if (!Number.isFinite(microdollars)) {
    return null;
  }
  if (microdollars <= 0) {
    return null;
  }
  if (microdollars >= 5000) {
    const cents = Math.round(microdollars / 10_000);
    if (cents <= 0) {
      return null;
    }
    if (cents < 100) {
      return `${cents} ${cents === 1 ? 'cent' : 'cents'}`;
    }
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    const dollarPart = `${dollars} ${dollars === 1 ? 'dollar' : 'dollars'}`;
    if (remainder === 0) {
      return dollarPart;
    }
    return `${dollarPart} ${remainder} ${remainder === 1 ? 'cent' : 'cents'}`;
  }
  // Sub-half-cent: fractional cents, 2 dp, trim trailing zeros.
  const fractional = microdollars / 10_000;
  const rounded = Math.round(fractional * 100) / 100;
  if (rounded <= 0) {
    return null;
  }
  const trimmed = String(rounded);
  return `${trimmed} cents`;
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
  /**
   * Backend `created_on_platform` string. When truthy, appended as the
   * FINAL spoken part (`from ${platformLabel(platform)}`). The caller
   * gates this: only pass when an icon is rendered, not needs-input, and
   * the eyebrow badge is a repo name (otherwise the badge already speaks
   * the platform label and appending would be redundant).
   */
  platform?: string | null;
};

/**
 * Compose the screen-reader label for a `SessionRow`, mirroring its visible
 * content in the order the row renders parts: title, then `needs input`
 * (only when the needs-input eyebrow is shown), then the always-visible
 * left-eyebrow badge, then the meta text (only when the row visibly
 * renders meta), then an optional platform origin (`from <LABEL>`). Empty
 * parts are skipped; the order is fixed.
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
  platform,
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
  if (platform) {
    parts.push(`from ${platformLabel(platform)}`);
  }
  return parts.join(', ');
}
