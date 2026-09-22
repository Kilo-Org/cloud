import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

const TAB_BAR_BASE_HEIGHT = 50;
const ANDROID_TAB_BAR_EXTRA_PADDING = 4;
export const TAB_LABEL_WRAP_FONT_SCALE = 1.8;
/**
 * Above this font scale the tab bar drops visible labels and switches to an
 * icon-forward presentation. The label height (which scales with fontScale) is
 * removed from the overlay height calculation, so the bar stays at the base
 * 50pt instead of ballooning. Labels remain available to assistive tech via
 * `tabBarAccessibilityLabel`. Picked above the label-wrap threshold so
 * moderate-to-large text still keeps a visible word label.
 */
export const TAB_ICON_FORWARD_FONT_SCALE = 2;
const TAB_ICON_BASE_SIZE = 22;
const TAB_ICON_MAX_SIZE = 26;

// Label metrics mirrored from `TabBarLabel`
// (`apps/mobile/src/components/tab-bar-label.tsx`): `font-mono-medium text-[11px]
// leading-4 uppercase tracking-[0.2px]`. Keep these in step with that style.
const TAB_LABEL_FONT_SIZE = 11;
const TAB_LABEL_LETTER_SPACING = 0.2;
/** JetBrains Mono (the `font-mono-medium` label) advances 0.6em per glyph. */
const MONO_ADVANCE_EM = 0.6;
/** CJK/Kana/Hangul/fullwidth glyphs render one em wide in the same stack. */
const FULL_WIDTH_ADVANCE_EM = 1;
/**
 * react-navigation's vertical tab item (`tabVerticalUiKit: { padding: 5 }` in
 * `BottomTabItem`), so a tab's label box is `tabWidth - 10`.
 */
const TAB_ITEM_HORIZONTAL_PADDING = 10;

type TabBarPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

export function getTabBarOverlayHeight(
  bottomInset: number,
  platform: TabBarPlatform,
  fontScale = 1
): number {
  const labelLines = fontScale > TAB_LABEL_WRAP_FONT_SCALE ? 2 : 1;
  const tabContentHeight = 34 + 16 * fontScale * labelLines;
  return (
    Math.max(TAB_BAR_BASE_HEIGHT, tabContentHeight) +
    Math.max(bottomInset, 0) +
    (platform === 'android' ? ANDROID_TAB_BAR_EXTRA_PADDING : 0)
  );
}

/**
 * Overlay height for the icon-forward presentation (font scale at or above
 * `TAB_ICON_FORWARD_FONT_SCALE`). The label is hidden so the bar can stay at
 * the base 50pt instead of growing with the (hidden) label height.
 */
export function getTabBarIconForwardHeight(bottomInset: number, platform: TabBarPlatform): number {
  return (
    TAB_BAR_BASE_HEIGHT +
    Math.max(bottomInset, 0) +
    (platform === 'android' ? ANDROID_TAB_BAR_EXTRA_PADDING : 0)
  );
}

/**
 * Bounded icon size for the tab bar. Icons grow gently with the system font
 * scale so they keep visual weight at large text, but are clamped to avoid
 * bloating the bar and pushing the layout out of premium density.
 */
export function getTabBarIconSize(fontScale = 1): number {
  const scaled = Math.round(TAB_ICON_BASE_SIZE * fontScale);
  return Math.min(TAB_ICON_MAX_SIZE, Math.max(TAB_ICON_BASE_SIZE, scaled));
}

/**
 * Effective rendered tab bar height for the current platform/font scale. This
 * is the single source of truth for both the tab bar itself and the content
 * clearance below it: it switches to the compact icon-forward height once labels
 * are hidden, and otherwise uses the label-inclusive overlay height. Callers
 * that already decided the label state (from the window width) pass it as
 * `showLabel`; the default keeps the font-scale-only answer. Tab screens use
 * `useEffectiveTabBarHeight` (`tab-bar-clearance.ts`), which supplies the tab
 * layout's decision so the clearance cannot drift from the rendered height.
 */
export function getEffectiveTabBarHeight({
  bottomInset,
  platform,
  fontScale = 1,
  showLabel = shouldShowTabLabel(fontScale),
}: {
  bottomInset: number;
  platform: TabBarPlatform;
  fontScale?: number;
  showLabel?: boolean;
}): number {
  return showLabel
    ? getTabBarOverlayHeight(bottomInset, platform, fontScale)
    : getTabBarIconForwardHeight(bottomInset, platform);
}

/**
 * Horizontal padding that keeps the tab bar icon row clear of the landscape
 * side safe areas (notch/Dynamic Island, Android cutouts). The bar's BlurBar
 * background stays full-bleed because it is absolutely positioned, so only the
 * icon row is inset. Zero insets (portrait) collapse to a no-op.
 */
export function getTabBarHorizontalInset({
  left = 0,
  right = 0,
}: {
  left?: number;
  right?: number;
}) {
  return {
    paddingLeft: Math.max(left, 0),
    paddingRight: Math.max(right, 0),
  };
}

/**
 * Whether the tab bar shows visible labels. Labels are dropped at and above
 * `TAB_ICON_FORWARD_FONT_SCALE` (the bar would balloon with the scaled label),
 * and when any label is too wide for its tab at the current window width (RN
 * would tail-ellipsize it, or wrap a `\n` line mid-word). With no `labels` the
 * per-tab width is unknown, so only the font-scale rule applies — the previous
 * behaviour, unchanged for callers that do not pass a tab width.
 */
export function shouldShowTabLabel(
  fontScale = 1,
  tabWidth = Number.POSITIVE_INFINITY,
  labels: readonly string[] = []
): boolean {
  if (fontScale >= TAB_ICON_FORWARD_FONT_SCALE) {
    return false;
  }
  if (labels.length === 0) {
    return true;
  }
  return labels.every(label => tabLabelFits(label, tabWidth, fontScale));
}

/**
 * Characters the tab label's monospace stack draws one em wide: CJK
 * ideographs, Kana, Hangul and fullwidth forms/punctuation. A conservative
 * class — it only bounds the glyph advance, so a stray match over-estimates
 * the width and hides the labels slightly earlier rather than leaving a
 * mid-word break on screen. Ranges mirror the `is-fullwidth-code-point` class.
 */
const FULL_WIDTH_CHARACTER =
  /[\u1100-\u115F\u2329\u232A\u2E80-\u3247\u3250-\u4DBF\u4E00-\uA4C6\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6B\uFF01-\uFF60\uFFE0-\uFFE6\u{1F200}-\u{1F251}\u{20000}-\u{3FFFD}]/u;

function isFullWidthCharacter(character: string): boolean {
  return FULL_WIDTH_CHARACTER.test(character);
}

/**
 * Estimated rendered width (dp) of the widest line of a tab label. A label is
 * one line (`tabLabelNumberOfLines`), except copy that carries its own break
 * (`Kilo\nClaw`), whose wider line is the one that has to fit. Only an explicit
 * break starts a new line: an ordinary space stays on the same one line and
 * counts toward its width (the renderer tail-ellipsizes, it does not wrap on a
 * space). The estimate is deliberately conservative: it only decides whether
 * the labels are dropped, so over-estimating hides them slightly early and
 * never leaves a clipped label on screen.
 */
export function tabLabelWidth(label: string, fontScale = 1): number {
  let widest = 0;
  for (const line of label.split('\n')) {
    let lineWidth = 0;
    for (const character of line) {
      const advanceEm = isFullWidthCharacter(character) ? FULL_WIDTH_ADVANCE_EM : MONO_ADVANCE_EM;
      lineWidth += advanceEm * TAB_LABEL_FONT_SIZE * fontScale + TAB_LABEL_LETTER_SPACING;
    }
    widest = Math.max(widest, lineWidth);
  }
  return widest;
}

/**
 * Whether `label` fits a tab item `tabWidth` dp wide without wrapping mid-word.
 * The item's own horizontal padding is removed first, matching
 * react-navigation's tab item (`padding: 5` on each side).
 */
export function tabLabelFits(label: string, tabWidth: number, fontScale = 1): boolean {
  const available = Math.max(tabWidth - TAB_ITEM_HORIZONTAL_PADDING, 0);
  return tabLabelWidth(label, fontScale) <= available;
}

/**
 * Line count for a bottom-tab label: one line, tail-truncated, unless the copy
 * carries its own break (`tabs.kiloclawWrapped` = "Kilo\nClaw"). A two-line
 * wrap of a single word wider than its tab breaks it mid-word and leaves the
 * bar unreadable (155c33b5), so no label is allowed to wrap on its own; the
 * explicit break is the only way to reach two lines.
 */
export function tabLabelNumberOfLines(label: string): 1 | 2 {
  return label.includes('\n') ? 2 : 1;
}

export function shouldHideTabBar(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  const isKiloClawInstancePicker = parts[0] === 'chat' && parts.length === 3;
  const isSecurityFindingFilter =
    parts[0] === 'security-agent' && parts.length === 3 && parts[2] === 'filter';
  return isKiloClawInstancePicker || isSecurityFindingFilter;
}

/** One tab bar entry, in render order. */
export type TabBarTab = 'home' | 'kiloclaw' | 'agents' | 'chat' | 'profile';

/** Flag state that changes which tabs render. */
export type TabBarTabFlags = {
  showKiloClaw: boolean;
  showQuickChat: boolean;
};

/**
 * Number of rendered tabs. Base three (Home, Agents, Profile) plus the two
 * flagged tabs when shown.
 */
export function visibleTabCount(showKiloClaw: boolean, showQuickChat: boolean): number {
  return 3 + Number(showKiloClaw) + Number(showQuickChat);
}

/**
 * One-based render position of a tab, or null when the tab is hidden. Home is
 * always 1; KiloClaw sits at 2 when shown; Agents follows KiloClaw; Chat
 * follows Agents when shown; Profile is always last.
 */
export function tabBarPosition(tab: TabBarTab, flags: TabBarTabFlags): number | null {
  switch (tab) {
    case 'home': {
      return 1;
    }
    case 'kiloclaw': {
      return flags.showKiloClaw ? 2 : null;
    }
    case 'agents': {
      return 2 + Number(flags.showKiloClaw);
    }
    case 'chat': {
      return flags.showQuickChat ? 3 + Number(flags.showKiloClaw) : null;
    }
    case 'profile': {
      return visibleTabCount(flags.showKiloClaw, flags.showQuickChat);
    }
    default: {
      // `TabBarTab` is a closed union; this branch is unreachable but keeps
      // `consistent-return` satisfied for an exhaustive switch.
      return null;
    }
  }
}

/**
 * Accessibility label for a tab bar entry. The position and the total must match
 * the rendered tab count, which changes when the KiloClaw tab is hidden.
 */
export function tabAccessibilityLabel(name: string, position: number, total: number): string {
  return i18n.t('tabs.position', {
    name,
    position: formatNumber(position, i18n.language),
    total: formatNumber(total, i18n.language),
  });
}
