/* eslint-disable max-lines -- one header contract: the title, eyebrow and subtitle slots, the back control, the action reflow, and the safe-area and offline-banner rules must stay in step */
import { type Href, useNavigationContainerRef, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { ChevronDown } from '@/components/ui/icons';
import { DirectionalChevronLeft } from '@/components/ui/directional-icons';
import { I18nManager, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useOfflineBannerSpace } from '@/components/offline-banner-space';
import { useHeaderBack } from '@/lib/hooks/use-header-back';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { offlineHeaderReservation } from '@/lib/offline-banner-state';
import { useScreenInsets, useSideInsetStyle } from '@/lib/screen-insets';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Top padding a modal header keeps above the native sheet's edge, clear of the
 * grabber. A sheet is its own window: the OS reports the inset it needs there
 * (zero for an inset card, the status-bar height for an edge-to-edge sheet), so
 * the header keeps this fixed clearance on iOS and Android alike instead of
 * re-adding the app window's safe-area inset.
 */
const MODAL_HEADER_TOP_PADDING = 32;

/**
 * Content width (dp, at font scale 1) a header needs for its title and its
 * actions to share one row.
 *
 * A narrow window cannot hold both. At the e1 geometry — 160dp wide with a 1.5
 * font scale — the shared row left the heading 48dp: the 30px list title, its
 * eyebrow, and the mono link beside it need about 180dp together, which is
 * about 120dp at scale 1. Every one of them broke into a single-letter column
 * and grew the header down over the search field. Below this width the actions
 * take their own row under the title, the reflow the design system asks of
 * narrow product UI. Wider windows keep the single-row layout byte-identical.
 */
const HEADER_SINGLE_ROW_MIN_CONTENT_WIDTH = 120;

/**
 * The horizontal gutter a header's content sits inside. The list screens use
 * the widest one in service (`px-[22px]`, 44dp); the default `px-4` is
 * narrower, so the check reflows a hair early for those callers instead of
 * squeezing them.
 */
const HEADER_CONTENT_GUTTER = 44;

/**
 * The `ms-3` gap the trailing cluster keeps from the heading, in dp. The
 * cluster and the heading are separate flex children, so the title loses this
 * as well whenever the row holds both.
 */
const HEADER_ACTIONS_GAP = 12;

/**
 * Whether the header's actions drop to their own row instead of sharing the
 * title's. `width` is the window width in dp; `fontScale` is the system font
 * scale, so a large font reflows before a small one at the same width.
 * `headerRightWidth` is the width the caller's trailing cluster lays out at, in
 * dp — the widths the caller renders, not a worst case it may never show. A
 * cluster wide enough to leave the title below its readable minimum reflows
 * too. Fixed-size children (icon buttons, a label capped at its own max-w) do
 * not grow with the font scale, so this width is taken as laid out and is not
 * scaled.
 */
export function shouldStackHeaderActions(
  width: number,
  fontScale: number,
  headerRightWidth = 0
): boolean {
  if (!Number.isFinite(width)) {
    return false;
  }
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const titleWidth = width - HEADER_CONTENT_GUTTER - HEADER_ACTIONS_GAP - headerRightWidth;
  return titleWidth < HEADER_SINGLE_ROW_MIN_CONTENT_WIDTH * scale;
}

/**
 * Ceiling for the header title's line cap. The reserved box grows by a full
 * line height per cap, so three lines is the most a header should take; the
 * Text and the reserve are clamped together to keep them in step.
 */
const MAX_TITLE_LINES = 3;

/**
 * What a reserved band's eyebrow twin lays out with: a space, so the twin
 * holds one eyebrow line without painting a label that is not on screen.
 */
const blankEyebrow = '\u00A0';

type ScreenHeaderProps = {
  /** Omit to render a bare back-button bar (e.g. when the screen body provides its own title). */
  title?: string;
  titleContent?: React.ReactNode;
  /**
   * Line cap for the title, at most {@link MAX_TITLE_LINES}. The default is
   * one line: a header title that does not fit ellipsizes at its tail instead
   * of wrapping. Android breaks CJK strings between any two characters, so a
   * two-line cap orphans the string's last characters (ja-JP
   * セキュリティエージェント rendered as 「…ジェン」 / 「ト」) — a tail
   * ellipsis is the only natural boundary a CJK title has. Callers whose
   * titles are real prose opt back into wrapping with an explicit cap
   * (session headers: `SESSION_HEADER_TITLE_LINES`, todos: 2).
   */
  titleNumberOfLines?: number;
  /**
   * One line of context under the title, in the muted body style. The title
   * stays the screen's name and its accessible header; the subtitle is read
   * after it, never instead of it.
   *
   * Kept to a single line with a tail ellipsis: it carries context such as the
   * profile a section edits, so a wrapped line would grow the header and move
   * the body below it. It is not the `eyebrow`, which is a category label the
   * text style uppercases; a user-authored name in that slot renders as
   * letterspaced small capitals.
   */
  subtitle?: string;
  /**
   * Reserve the subtitle's line even when there is none yet, so a name that
   * arrives after the first render (a cold deep link's profile read) cannot
   * change the header's height. The reserved line is the same style as the
   * text, so it scales with the font size the way the real line does.
   */
  reserveSubtitle?: boolean;
  /**
   * Cap the eyebrow to this many lines, overriding the header's default single
   * line. When set the eyebrow ellipsizes in the middle: the repo name is the
   * distinguishing tail of a path, so a middle ellipsis keeps more of it than a
   * tail ellipsis. Left undefined every caller keeps the default one-line tail
   * ellipsis, so a long repository label never reflows the header.
   */
  eyebrowNumberOfLines?: number;
  /** Reserve the title's line cap so state changes do not move the screen body. */
  reserveTitleSpace?: boolean;
  /** Optional mono-uppercase line above the title. */
  eyebrow?: string;
  reserveEyebrow?: boolean;
  centerTitle?: boolean;
  /** Use Focus's large 30px H1 style (list roots). Default 18px (detail). */
  size?: 'default' | 'large';
  headerRight?: React.ReactNode;
  /**
   * Width the `headerRight` cluster lays out at, in dp. The stacking decision
   * reserves it (see `shouldStackHeaderActions`), so a wide cluster reflows the
   * actions onto their own row instead of squeezing the title to a few
   * characters. Pass the widths of the controls actually rendered. Omit it for
   * a cluster no wider than a single icon button.
   */
  headerRightWidth?: number;
  /** Keep compact fixed-width controls beside the title even on narrow screens. */
  allowHeaderRightStacking?: boolean;
  /**
   * The `headerRight` cluster shrinks and truncates on its own (the session
   * header's context pill: `min-w-0 shrink`, one-line cost). The slot then
   * keeps its half-row cap, so an unbounded value truncates inside the cluster
   * instead of pushing the title to zero width and the pill past the screen
   * edge. Leave it off for fixed-width controls: a capped box cannot shrink
   * them, so they would paint past it.
   */
  headerRightShrinks?: boolean;
  /** Controls rendered at the trailing edge of the title row, in the
   * leading-aligned row and beside a centered title alike. The heading keeps
   * `flex-1 min-w-0`, so the title keeps its tail ellipsis and the controls keep
   * their full width instead of the `headerRight` half-row cap wrapping them.
   * Pass `inlineActionsWidth` for a cluster wide enough to squeeze the title:
   * the row then drops beneath the title once the two cannot share. */
  inlineActions?: React.ReactNode;
  /**
   * Width the `inlineActions` cluster lays out at, in dp. The stacking decision
   * reserves it (see `shouldStackHeaderActions`) exactly as `headerRightWidth`
   * does for `headerRight`: on a phone the Agents controls are as wide as the
   * title's readable minimum, so without this the 30px title broke mid-word
   * beside them (Croatian "Agenti" → "Age" / "nti"). Omit it for a cluster no
   * wider than the title can spare.
   */
  inlineActionsWidth?: number;
  /**
   * Keep the `inlineActions` cluster on the title row even when the shared-row
   * check would reflow it. That check reserves a readable title, and the home
   * header's heading is a fixed 40dp mark with no text, so the reserve does not
   * apply: at a 2.5x accessibility font scale the account picker would drop
   * under the mark on a phone wide enough to hold both. Leave it on for a
   * heading that carries text.
   */
  allowInlineActionsStacking?: boolean;
  modal?: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  /** Keep Back available without history, replacing the current route with this destination. */
  backFallback?: Href;
  onTitlePress?: () => void;
  /**
   * Accessibility hint for the pressable title: the action it opens. The
   * title's own text stays the label, so a screen reader announces which
   * screen it is on before the action. Defaults to the generic open-menu copy.
   * Detail screens (e.g. session rename) supply a verb that describes their
   * action, not "open menu".
   */
  onTitlePressAccessibilityHint?: string;
  backIcon?: 'back' | 'close';
  /**
   * Apply the status-bar safe-area inset. Form sheets already clear the
   * grabber; passing false leaves vertical padding to `className`. The
   * landscape side insets apply regardless, so every caller clears the
   * sensor/cutout horizontally.
   */
  safeAreaTop?: boolean;
  /** Extra classes on the outer header container. Overrides the default `px-4` for screens that need a different horizontal inset. */
  className?: string;
};

/**
 * Height of the reserved title box for `reserveTitleSpace`, one title line
 * height per line the title can paint: the default 18px title's Tailwind line
 * height is `1.75rem`, the large 30px variant's is 36px. Class names must be
 * static because NativeWind extracts them at build time. The reserve tracks the
 * line cap so a title that grows a line (loading -> loaded, rename) cannot move
 * the body below the header — and a one-line cap reserves one line, not the
 * two-line default it replaced, or the header keeps a blank line it can never
 * fill.
 *
 * The box is the measure the header's reserved band keeps its height by (see
 * `reservedTitleBand`): an empty box at the title's own position, so a title
 * that grows a line cannot move the body below the header — and a one-line cap
 * reserves one line, not the two-line default it replaced, or the band keeps a
 * blank line it can never fill.
 *
 * The large branches stay in px: NativeWind's rem is 14pt, so `min-h-9` would
 * be 31.5pt under the 36px the large title paints.
 */
function reservedTitleHeightClass(size: ScreenHeaderProps['size'], titleLines: number): string {
  if (size === 'large') {
    if (titleLines > 2) {
      return 'min-h-[108px]';
    }
    return titleLines === 1 ? 'min-h-[36px]' : 'min-h-[72px]';
  }
  if (titleLines > 2) {
    return 'min-h-21';
  }
  return titleLines === 1 ? 'min-h-7' : 'min-h-14';
}

/**
 * Whether the header's back control can pop, re-read on every navigation
 * commit.
 *
 * `router.canGoBack()` is a snapshot of the shared navigation container, and a
 * screen that the relaunch repair or a deep link restores first renders before
 * the navigators above it hold their parent screens — the read is false at
 * that moment, and the header would then keep painting no back control for a
 * screen that is sitting on a complete stack (measured on a code-reviewer edit
 * screen restored after process death: no back control until an unrelated
 * re-render). The container's `state` event arrives after that commit, so
 * re-reading here is what fills the control in; the state comparison makes
 * React skip the render while the answer is unchanged, the same way
 * `useRootNavigationReady` watches the same ref.
 */
function useCanGoBack(): boolean {
  const router = useRouter();
  const navigationRef = useNavigationContainerRef();
  const [canGoBack, setCanGoBack] = useState<boolean>(() => router.canGoBack());
  useEffect(() => {
    const update = () => {
      setCanGoBack(router.canGoBack());
    };
    update();
    return navigationRef.addListener('state', update);
  }, [navigationRef, router]);
  return canGoBack;
}

export function ScreenHeader({
  title,
  titleContent,
  titleNumberOfLines = 1,
  subtitle,
  reserveSubtitle = false,
  eyebrowNumberOfLines,
  reserveTitleSpace = false,
  eyebrow,
  reserveEyebrow = false,
  size = 'default',
  headerRight,
  headerRightWidth,
  allowHeaderRightStacking = true,
  headerRightShrinks = false,
  inlineActions,
  inlineActionsWidth,
  allowInlineActionsStacking = true,
  modal,
  centerTitle = modal ?? false,
  showBackButton,
  onBack,
  backFallback,
  onTitlePress,
  onTitlePressAccessibilityHint,
  backIcon,
  safeAreaTop = true,
  className,
}: Readonly<ScreenHeaderProps>) {
  const insets = useScreenInsets();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const fontScale = useLiveFontScale();
  const historyCanGoBack = useCanGoBack();
  const canGoBack = showBackButton ?? (historyCanGoBack || backFallback !== undefined);
  const handleBack = useHeaderBack({ onBack, backFallback, canGoBack: historyCanGoBack });
  const isOfflineBannerVisible = useOfflineBannerSpace();
  // A window too narrow to hold the title beside its actions drops the actions
  // to their own row instead of squeezing the title into a single-letter
  // column. Only a header that has actions can reflow this way, and a caller
  // that declares its cluster's width reflows before that cluster eats the
  // title's readable minimum (see `headerRightWidth`).
  const stackActions =
    allowHeaderRightStacking &&
    headerRight != null &&
    shouldStackHeaderActions(windowWidth, fontScale, headerRightWidth ?? 0);
  // The inline controls row reflows the same way: a caller that declares its
  // width drops it beneath the title before it squeezes the title's own
  // readable minimum, so the 30px Agents title never breaks inside a word.
  const stackInlineActions =
    allowInlineActionsStacking &&
    inlineActions != null &&
    shouldStackHeaderActions(windowWidth, fontScale, inlineActionsWidth ?? 0);

  // A modal is a native sheet that owns its own top inset; the header keeps the
  // fixed grabber clearance on both platforms. A pinned header adds the app
  // window's safe-area top inset plus the standard 8. One expression, no
  // platform branch: both platforms have the same native-sheet capability.
  const baseTopPadding = modal ? MODAL_HEADER_TOP_PADDING : insets.top + 8;

  // The offline banner is an absolute overlay pinned at the safe-area top of
  // the app window, so a pinned header must reserve its height while it is
  // visible or the banner covers the title (gr2 spot check, e6-offline-nav). A
  // modal is a separate native sheet window above the banner, so a modal header
  // never reserves.
  const reserveOfflineBanner = safeAreaTop && isOfflineBannerVisible && !modal;
  const paddingTop = baseTopPadding + offlineHeaderReservation(reserveOfflineBanner);

  // `paddingTop` stays conditional on `safeAreaTop`: a form sheet owns its
  // vertical padding through `className`.
  const safeAreaStyle = safeAreaTop ? { paddingTop } : undefined;

  // The shared inset hook keeps the chrome and body clear of side status areas
  // and rounded corners. The inner wrapper adds this clearance to the gutter
  // instead of replacing its className padding.
  const sideInsetStyle = useSideInsetStyle();

  // When `backIcon` isn't specified, fall back to the historical behaviour
  // where iOS modals get a ChevronDown and everything else gets a ChevronLeft.
  const resolvedBackIcon = backIcon ?? (modal && Platform.OS === 'ios' ? 'close' : 'back');

  const titleClass =
    size === 'large'
      ? 'shrink text-[30px] font-bold tracking-tight text-foreground'
      : 'shrink text-lg font-semibold text-foreground';

  // One cap for the Text and the reserved box: a title capped deeper than the
  // reserve would shift the body the moment it reached the extra line.
  const titleLines = Math.min(Math.max(titleNumberOfLines, 1), MAX_TITLE_LINES);

  // The slop widens the title into the free space beside it. RN does not mirror
  // hitSlop under RTL, so the physical right slop would reach across the
  // visually mirrored back control and the title (the later sibling) would win
  // those taps — spell the free side per direction instead.
  const titleHitSlop = I18nManager.isRTL
    ? { top: 13, right: 0, bottom: 13, left: 13 }
    : { top: 13, right: 13, bottom: 13, left: 0 };

  // What pressing the title does. The pressable title itself is labelled with
  // the title's own text, so this is the hint, never the label: a screen reader
  // must hear which screen it is on before the action. It names the title it
  // opens, or falls back to the generic menu copy for a header with no text
  // title.
  const titlePressHint =
    onTitlePressAccessibilityHint ??
    (title ? t('screenHeader.openMenuFor', { title }) : t('screenHeader.openMenu'));

  let titleNode: React.ReactNode = null;
  if (title != null) {
    const titleText = titleContent ? (
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={title}
        className={cn('shrink-0', centerTitle && 'items-center')}
      >
        {titleContent}
      </View>
    ) : (
      <Text
        className={cn(titleClass, centerTitle && 'text-center')}
        numberOfLines={titleLines}
        ellipsizeMode="tail"
        accessibilityRole="header"
      >
        {title}
      </Text>
    );
    // The visible title paints at its own height: the reserved line lives in
    // the band beside the heading (see `reservedTitleBand`), never around the
    // text, so the eyebrow keeps its tight pair with the title's first line.
    // Title caret removed: rename stays available via the pressable title
    // itself. The backIcon === 'close' ChevronDown on the back control is
    // unrelated and stays. The label is the title text, never the action: a
    // screen reader must hear which screen it is on, and the action goes in
    // the hint (a rename control announced in place of the title left the
    // title unreadable on the to-do detail screen).
    titleNode = onTitlePress ? (
      <Pressable
        onPress={onTitlePress}
        hitSlop={titleHitSlop}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={titlePressHint}
        className="min-h-[48px] justify-center active:opacity-70"
      >
        {titleText}
      </Pressable>
    ) : (
      titleText
    );
  }

  const heading = (
    <View className="min-w-0 flex-1">
      {eyebrow || reserveEyebrow ? (
        <Eyebrow
          className={cn('mb-0.5', centerTitle && 'text-center', !eyebrow && 'opacity-0')}
          // A status line is one line: a narrow window truncates it rather than
          // stacking it into a column beside the title. A caller that raises
          // `eyebrowNumberOfLines` opts into the extra lines and the middle
          // ellipsis that keeps a path's distinguishing tail.
          numberOfLines={eyebrowNumberOfLines ?? 1}
          ellipsizeMode={eyebrowNumberOfLines === undefined ? 'tail' : 'middle'}
          accessible={Boolean(eyebrow)}
          accessibilityElementsHidden={!eyebrow}
          importantForAccessibility={eyebrow ? 'auto' : 'no-hide-descendants'}
        >
          {eyebrow ?? '\u00A0'}
        </Eyebrow>
      ) : null}
      {titleNode}
      {subtitle || reserveSubtitle ? (
        <Text
          variant="muted"
          className={cn('mt-0.5', centerTitle && 'text-center', !subtitle && 'opacity-0')}
          // One line: the subtitle is context for the title, so it truncates at
          // its tail instead of taking a second line and moving the body. The
          // reserved copy is a no-break space in the same style, so the height
          // it holds is the height the name will take.
          numberOfLines={1}
          ellipsizeMode="tail"
          accessible={Boolean(subtitle)}
          accessibilityElementsHidden={!subtitle}
          importantForAccessibility={subtitle ? 'auto' : 'no-hide-descendants'}
        >
          {subtitle ?? '\u00A0'}
        </Text>
      ) : null}
    </View>
  );
  // A centered title shares its row with the leading and trailing controls.
  // A spacer opposite the back control keeps the title centered on the full
  // width without placing either control out of flow.
  const separateHeading = centerTitle && (Boolean(title) || Boolean(eyebrow));

  // The reserve, as a band rather than a box around the title: a zero-width,
  // clipped twin of the eyebrow and the title's line cap holds the header's text
  // area to one height for every line count the cap allows, so a title that
  // grows a line cannot move the body below. The visible text stays at its
  // natural height and centers on the band, which is what lines the leading
  // control up with the text rather than with the empty line the reserve keeps.
  // The twin lays out with the same eyebrow style and the same cap box as the
  // visible title, so the band follows the font scale, and it needs no measured
  // height and no line-height constant.
  const reservedTitleBand = reserveTitleSpace ? (
    <View className="w-0 overflow-hidden" aria-hidden>
      {eyebrow || reserveEyebrow ? <Eyebrow className="mb-0.5">{blankEyebrow}</Eyebrow> : null}
      <View className={reservedTitleHeightClass(size, titleLines)} />
    </View>
  ) : null;

  // The leading control's pull into the gutter is a START-side margin, never a
  // hand-picked `mr` under RTL. With `I18nManager.doLeftAndRightSwapInRTL` on
  // (the default) React Native rewrites margin Left/Right to Yoga Start/End
  // before layout (YogaLayoutableShadowNode `swapLeftAndRightInYogaStyleProps`),
  // so `-mr-4` under RTL becomes a negative END margin — the side facing the
  // title — and the heading (the next sibling, whose interactive title fills
  // it) starts 12 points under the back control's target. Measured on
  // the row: the title box covered 0.27 of the back target's area, and the
  // explorer's `overlapping_controls` scan reports above 0.25. A
  // `marginInlineStart` is resolved to Yoga Start in both directions, so `-ms-4`
  // pulls the control into the gutter and leaves the 4-point `gap-1` intact.
  //
  // The control's box is the shared 48dp icon target (`ICON_TARGET_BOX_CLASS`):
  // the audit reads the node's view rect, so `hitSlop` cannot carry an
  // `h-11` frame to Android's 48dp minimum.
  //
  // Frame and target are separate views because Android paints the press and
  // focus surface across the whole target: a bare 48dp target flush against the
  // screen edge showed up as a hard gray square taller than the title row
  // whenever the device had keyboard or D-pad focus (measured on the emulator:
  // `#E8E7E3` over the target's full rect, sharp corners, from the first TAB
  // press). The frame clips that surface to a circle, so the control reads as an
  // icon button while it stays focusable and keeps the same rect, gutter pull
  // and label.
  const backControl = canGoBack ? (
    <View className={cn('shrink-0 overflow-hidden rounded-full', !separateHeading && '-ms-4')}>
      <Pressable
        onPress={handleBack}
        accessibilityRole="button"
        accessibilityLabel={resolvedBackIcon === 'close' ? t('common.close') : t('common.goBack')}
        className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
      >
        {resolvedBackIcon === 'close' ? (
          <ChevronDown size={24} color={colors.foreground} />
        ) : (
          <DirectionalChevronLeft size={24} color={colors.foreground} />
        )}
      </Pressable>
    </View>
  ) : null;
  // A fixed-width trailing cluster sizes to its content and never shrinks
  // (`shrink-0`). A `max-w-[50%] shrink` cap clamped the cluster's box on
  // narrow screens while its fixed-width children kept painting at their full
  // width, so the last control's glyphs ran past the right screen edge and were
  // cut off (device capture, session-compose-kbup). Content sizing moves the
  // squeeze to the title: `heading` is `min-w-0 flex-1`, so a long title
  // truncates in place and the controls stay whole inside the screen's own
  // padding. By default, a window too narrow to hold both drops the actions to
  // their own row (`stackActions`). A variable-width button caps itself, as the
  // Security Agent settings Save button does with a 140 dp max-w.
  //
  // A cluster that shrinks on its own (`headerRightShrinks`) keeps the
  // half-row cap: its unbounded text truncates inside the cap, and the title
  // keeps the other half of the row.
  const headerRightSlotClassName = headerRightShrinks
    ? 'ms-3 max-w-[50%] min-w-0 shrink'
    : 'ms-3 shrink-0';
  const centeredControls =
    separateHeading &&
    backControl &&
    (!inlineActions || stackInlineActions) &&
    (!headerRight || stackActions) ? (
      <View
        className="h-[48px] w-[48px] shrink-0"
        accessibilityElementsHidden
        pointerEvents="none"
      />
    ) : null;
  // The inline controls keep the title's row only while it can still hold a
  // readable title; below that they take a row of their own. On their own row
  // they keep the header's full width, so a long translation (Croatian
  // "TRENUTAČNO AKTIVNO" / "PRETHODNE SESIJE" beside the filter) stays legible
  // instead of squeezing the 30px title into a mid-word break.
  //
  // A caller that turns the reflow off has to cap the slot instead: the heading
  // is `flex-1` over a zero basis, so an unbounded trailing cluster resolves
  // all negative free space on itself and leaves the heading at zero width,
  // where a fixed-size child such as the Home mark paints under the cluster.
  // The half-row cap is the same one `headerRightShrinks` uses; with it the
  // free space can never go negative, so the heading always keeps its share.
  const inlineActionsSlot =
    inlineActions && !stackInlineActions ? (
      <View className={cn('ms-3 min-w-0 shrink', !allowInlineActionsStacking && 'max-w-[50%]')}>
        {inlineActions}
      </View>
    ) : null;
  const stackedInlineActionsRow =
    inlineActions && stackInlineActions ? (
      <View className="mt-2 min-w-0">{inlineActions}</View>
    ) : null;

  return (
    <View className={cn('bg-background px-4 pb-3', className)} style={safeAreaStyle}>
      <View style={sideInsetStyle}>
        {separateHeading ? (
          <>
            <View className="min-h-11 flex-row items-center">
              {backControl}
              <View className="min-w-0 flex-1 flex-row items-center justify-center">{heading}</View>
              {reservedTitleBand}
              {headerRight && !stackActions ? (
                <View className={headerRightSlotClassName}>{headerRight}</View>
              ) : (
                centeredControls
              )}
              {inlineActionsSlot}
            </View>
            {headerRight && stackActions ? (
              // The actions keep the title's own row only while it can hold a
              // readable title; below that they take a row of their own. They
              // keep the row's full width so a long translation still wraps
              // inside it instead of running off the edge.
              <View className="mt-2 min-w-0">{headerRight}</View>
            ) : null}
            {stackedInlineActionsRow}
          </>
        ) : (
          <>
            <View className="flex-row items-center">
              <View className="min-w-0 flex-1 flex-row items-center gap-1">
                {backControl}
                {heading}
              </View>
              {reservedTitleBand}
              {headerRight && !stackActions ? (
                <View className={headerRightSlotClassName}>{headerRight}</View>
              ) : null}
              {inlineActionsSlot}
            </View>
            {headerRight && stackActions ? (
              <View className="mt-2 min-w-0">{headerRight}</View>
            ) : null}
            {stackedInlineActionsRow}
          </>
        )}
      </View>
    </View>
  );
}
