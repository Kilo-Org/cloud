import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { listFormat } from '@/lib/intl-cache';
import { platformLabel } from '@/lib/platform-label';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * Speech-friendly relative-time formatter.
 *
 * `timeAgo` (`@/lib/utils`) now returns `Intl.RelativeTimeFormat` words
 * like `"5 minutes ago"`, `"yesterday"`, or `"just now"`, which VoiceOver
 * already reads as words. This helper is a pass-through wrapper that keeps
 * the screen-reader call site explicit. `nowMs` is the caller's sampled clock
 * so the spoken label ages with the visible one inside a memoized row.
 */
export function formatSpokenTimeAgo(timestamp: string | null | undefined, nowMs?: number): string {
  const date = parseTimestamp(timestamp);
  return Number.isNaN(date.getTime()) ? '' : timeAgo(date, undefined, nowMs);
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
      return `${formatNumber(cents, i18n.language)} ${i18n.t('agents.sessionRow.cent', {
        count: cents,
      })}`;
    }
    const dollars = Math.floor(cents / 100);
    const remainder = cents % 100;
    const dollarPart = `${formatNumber(dollars, i18n.language)} ${i18n.t(
      'agents.sessionRow.dollar',
      { count: dollars }
    )}`;
    if (remainder === 0) {
      return dollarPart;
    }
    return `${dollarPart} ${formatNumber(remainder, i18n.language)} ${i18n.t(
      'agents.sessionRow.cent',
      { count: remainder }
    )}`;
  }
  // Sub-half-cent: fractional cents, 2 dp, trim trailing zeros.
  const fractional = microdollars / 10_000;
  const rounded = Math.round(fractional * 100) / 100;
  if (rounded <= 0) {
    return null;
  }
  return `${formatNumber(rounded, i18n.language, { maximumFractionDigits: 2 })} ${i18n.t(
    'agents.sessionRow.cent',
    { count: rounded }
  )}`;
}

type SessionRowAccessibilityLabelInputs = {
  /** Row title, always present (e.g. "Untitled session" fallback). */
  title: string;
  /** True when the row's right eyebrow renders the `NEEDS INPUT` state. */
  needsInput: boolean;
  /** Opt-in live status for stored list rows; needs-input speech takes priority. */
  live?: boolean;
  /**
   * The row glyph's kind from the one shared derivation
   * (`glanceableStatusKind(session.status)` — the exact value the row passes
   * to its status glyph). When set on a live row whose needs-input flag is
   * down, the label names the state the glyph draws instead of the static
   * LIVE eyebrow word: `common.working` for running, `common.idle` for idle.
   * A `scheduled` kind always speaks `common.scheduled` (the Clock the row
   * draws), whether or not the row is live — a stored history row shows the
   * SCHEDULED label too. Omit it (or pass null) to keep the static word, so
   * callers that do not pass it are byte-identical to before.
   */
  statusKind?: GlanceableStatusKind | null;
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
   * Branch provenance text visible below the title. Spoken after `title`
   * (and `needs input` when set) and before the pull-request phrase.
   */
  subtitle?: string | null;
  /**
   * Associated pull-request number. When set, spoken as
   * `pull request <number>` after the branch text. Callers omit it for
   * rows that do not show the PR mark.
   */
  prNumber?: number | null;
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
 * (or, on a `scheduled` row, `Scheduled`; or, on a live row, the state word
 * the status glyph draws when the caller passes `statusKind` from the shared
 * derivation — else the static LIVE eyebrow word), then the branch subtitle
 * (when present), then the `pull request <number>` phrase (when `prNumber`
 * is set), then the always-visible left-eyebrow badge, then the meta text
 * (only when the row visibly renders meta), then an optional platform origin
 * (`from <LABEL>`). Empty parts are skipped; the order is fixed.
 *
 * Examples without the opt-in live status, aligned with `selectSessionRowEyebrowRight`:
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
  live = false,
  statusKind = null,
  badge,
  meta,
  subtitle,
  prNumber,
  platform,
}: SessionRowAccessibilityLabelInputs): string {
  const parts: string[] = [title];
  if (needsInput) {
    parts.push(i18n.t('agents.sessionRow.needsInput'));
  } else if (statusKind === 'scheduled') {
    // A scheduled row draws the Clock and the SCHEDULED label whether or not
    // it is live (a stored history row reads SCHEDULED too), so the state word
    // is spoken without the live gate. The wake time, when known, rides in
    // `meta` and is appended below.
    parts.push(i18n.t('common.scheduled'));
  } else if (live) {
    if (statusKind != null) {
      // Name the state the glyph draws. The ui row renders the running glyph
      // for any set kind but idle, so a `needsInput` kind with the attention
      // flag down (acked, or `retry`) draws running and is spoken as working.
      parts.push(i18n.t(statusKind === 'idle' ? 'common.idle' : 'common.working'));
    } else {
      parts.push(i18n.t('agents.sessionList.live'));
    }
  }
  if (subtitle) {
    parts.push(subtitle);
  }
  if (prNumber != null) {
    parts.push(i18n.t('agents.sessionRow.pullRequest', { number: prNumber }));
  }
  if (badge) {
    parts.push(badge);
  }
  if (meta) {
    parts.push(meta);
  }
  if (platform) {
    parts.push(i18n.t('agents.sessionRow.fromPlatform', { platform: platformLabel(platform) }));
  }
  const format = listFormat(i18n.language, { style: 'long', type: 'conjunction' });
  // Two fragments are plain labels ("title, badge"): the locale list
  // formatter's own coupling is right for them. From three on, the last
  // fragments are clauses — a relative time, a cost sentence, an origin
  // phrase — and a conjunction between a label and a clause speaks as a second
  // list item, so the coupling before the last fragment comes from the catalog
  // as that locale's pause mark and keeps this formatter's spacing around it.
  if (parts.length < 3) {
    return format.format(parts);
  }
  const tokens = format.formatToParts(parts);
  let lastLiteral = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type === 'literal') {
      lastLiteral = index;
      break;
    }
  }
  const literalToken = lastLiteral === -1 ? undefined : tokens[lastLiteral];
  if (!literalToken) {
    return parts.join(' ');
  }
  const literal = literalToken.value;
  const joiner = i18n.t('agents.sessionRow.spokenJoiner');
  // A pause mark binds to the word before it and takes this locale's separator
  // spacing after it. Every punctuation category binds this way, not a
  // hand-listed few: the Ethiopic (`፣`), Myanmar (`၊`) and CJK (`，`, `、`)
  // commas are punctuation too, and a space before one is never right.
  const pausesFragments = /^\p{P}/u.test(joiner);
  const leading = pausesFragments ? '' : /^\s*/u.exec(literal)?.[0];
  // A pause mark is a separator, so its following space comes from the
  // formatter's first separator; the literal it replaces may abut the next word
  // because that word was the conjunction's own (`th`, `he`). A joiner that
  // ends in a hyphen is a prefix that still binds forward, so it keeps no
  // space of its own.
  const separator = tokens.find(token => token.type === 'literal');
  const spacing = pausesFragments ? (separator?.value ?? literal) : literal;
  // That first separator spells this locale's word space in one of two
  // positions: after the pause (`", "` in most locales) or, where its
  // conjunction word is a prefix that attaches to the next word, before it
  // (`" و"` in Arabic, `" ו-"` in Hebrew). A pause mark is not that prefix, so
  // it still needs the locale's word space, which is the literal's leading half
  // when the trailing half is empty. A literal with neither half writes no
  // space after its pause (the CJK `、` and `，`), so those locales keep their
  // current output.
  const trailingWhitespace = /\s*$/u.exec(spacing)?.[0] ?? '';
  const prefixSpacing = /\p{P}$/u.test(joiner) ? (/\s*/u.exec(spacing)?.[0] ?? '') : '';
  const wordSpace = trailingWhitespace || prefixSpacing;
  const trailing = joiner.endsWith('-') ? '' : wordSpace;
  tokens[lastLiteral] = { type: 'literal', value: `${leading ?? ''}${joiner}${trailing}` };
  return tokens.map(token => token.value).join('');
}
