/* eslint-disable max-lines -- one header contract: the title, eyebrow and subtitle slots, the back control, the action reflow, and the safe-area and offline-banner rules must stay in step */
import { type Href, useNavigationContainerRef, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { ChevronDown } from '@/components/ui/icons';
import { DirectionalChevronLeft } from '@/components/ui/directional-icons';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useOfflineBannerSpace } from '@/components/offline-banner-space';
import { useHeaderBack } from '@/lib/hooks/use-header-back';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type SheetHeaderTopInset, useSheetHeaderTopClearance } from '@/lib/form-sheet';
import { offlineHeaderReservation } from '@/lib/offline-banner-state';
import { useScreenInsets, useSideInsetStyle } from '@/lib/screen-insets';
import { HEADER_TITLE_TARGET_CLASS, ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Top padding a modal header keeps above its surface's own top edge, clear of
 * the grabber. The surface decides who owns the top of the window: a full-window
 * surface lets the header reach the status bar, while a native sheet presents
 * below it and provides the clearance itself (see `modalTopInset` and
 * `useSheetHeaderTopClearance`). The padding is the larger of this grabber
 * clearance and the surface's own top inset plus the standard header gap, so a
 * header never paints inside the system bar and never leaves a dead band.
 */
const MODAL_HEADER_TOP_PADDING = 32;

/**
 * The gap a header keeps between the top of what the surface already clears and
 * its own content. One value for a pinned screen and a modal, so the same title
 * sits at the same distance from the system bar on both.
 */
const HEADER_TOP_GAP = 8;

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
 * What a reserve lays out when it cannot know the label that will fill it: a
 * no-break space, which paints no ink. It holds the eyebrow variant's single
 * line box (`EYEBROW_LINE_HEIGHT_DP` in `ui/text.tsx`), which no longer depends
 * on the script, so any zero-ink filler reserves exactly the height the arriving
 * label takes. A caller that knows the label passes `reservedEyebrow` and the
 * reserve lays out that label itself.
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
   * How the title truncates when it does not fit its line cap. Default `'tail'`,
   * which is right for a screen's own name: the start of a name is what a
   * reader scans for.
   *
   * A title that carries a scope's name (the organization invoices screen puts
   * the membership's organization name here) wants `'middle'` instead: the
   * tail of a name is what tells two names with a shared prefix apart, and a
   * tail ellipsis clipped exactly that, so "Acme Studio" and "Acme Studio
   * Nordics" both read as "Acme Studio…". A middle ellipsis keeps both ends
   * without taking a second line, so the header's height still cannot change
   * when the name arrives.
   */
  titleEllipsizeMode?: 'head' | 'middle' | 'tail' | 'clip';
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
   * What the reserved subtitle line paints while the caller's text is not
   * available yet, such as a placeholder bar the size of the name to come. It
   * is drawn over the reserved text, which still holds the line's height, so
   * neither the placeholder nor the arriving text moves the body. The caller
   * supplies the node, so the header itself pulls in no loading surface.
   */
  subtitlePlaceholder?: React.ReactNode;
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
  /**
   * Render this label in the reserve instead of the blank filler, so the
   * reserved eyebrow line holds the exact box of the label that replaces it —
   * pass it when the caller knows the label before it paints (the invoices
   * boundary passes the screen's own name). The eyebrow variant holds one line
   * box for every script (`EYEBROW_LINE_HEIGHT_DP`), so the blank filler already
   * reserves the height a label takes; this is for the caller that owns the
   * label and wants the reserve to lay it out rather than a stand-in. The
   * reserve paints nothing either way (a zero-width, clipped, `aria-hidden`
   * twin), so this is the label's metrics, not its text.
   */
  reservedEyebrow?: string;
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
  /**
   * Which surface owns the top of the window for this modal header, resolved by
   * `useSheetHeaderTopClearance` (`@/lib/form-sheet`). The `modal` presentation
   * is a full-window surface on Android and a native sheet that presents below
   * the status bar elsewhere, which is `'android-window-top'`; a `formSheet`
   * caller passes `'bottom-form-sheet'` so the header never re-adds an inset the
   * sheet edge already provides. Ignored when `modal` is off.
   */
  modalTopInset?: SheetHeaderTopInset;
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
 * Measured one-line title boxes at font scale 1, in dp: the 18px default
 * title's `text-lg` box and the 30px large title's. A one-line title sits
 * centred in the 48 dp band the caret occupies, so half of what the band leaves
 * outside this box is empty above the title and half below it.
 */
const TITLE_LINE_HEIGHT_DP = { default: 24.76, large: 41.27 } as const;

/** The `mb-0.5` (1.75 dp, NativeWind's 0.25rem at 14pt) gap the eyebrow keeps from the title line. */
const EYEBROW_GAP_DP = 1.75;

/**
 * The band the header's title occupies, and the band the leading control
 * occupies beside it. One class for both, so the two cells measure the same
 * height and the row's `items-center` lines the control up with the title at
 * every font scale. One line of a detail title is shorter than the control's
 * 48 dp target, and a control has to live in a box of its own size for
 * React Native to deliver its touches — a 48 dp box inside a 24.8 dp parent is
 * reachable only across the parent's bounds — so the band is the control's
 * height whenever the title's own reserve is shorter. A deeper title cap keeps
 * its reserve, so a name that wraps cannot move the body either.
 */
function titleBandClass(size: ScreenHeaderProps['size'], titleLines: number): string {
  return titleLines === 1 ? 'min-h-[48px]' : reservedTitleHeightClass(size, titleLines);
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
  titleEllipsizeMode = 'tail',
  subtitle,
  reserveSubtitle = false,
  subtitlePlaceholder,
  eyebrowNumberOfLines,
  reserveTitleSpace = false,
  eyebrow,
  reservedEyebrow,
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
  modalTopInset = 'android-window-top',
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

  // A surface that reaches the window top (a full-window modal) needs the
  // status bar and corner pad added on top of the standard gap; one that
  // presents below it (a native sheet) reports nothing here, so the header keeps
  // its grabber clearance and never pads twice. A pinned header is always the
  // window's own surface and reads no sheet clearance at all.
  const surfaceTopClearance = useSheetHeaderTopClearance(modal ? modalTopInset : undefined);
  const baseTopPadding = modal
    ? Math.max(MODAL_HEADER_TOP_PADDING, surfaceTopClearance + HEADER_TOP_GAP)
    : insets.top + HEADER_TOP_GAP;

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

  // The title's touch area stays inside its own column. The free side beside
  // the heading is the row's gap to the trailing slot, and a trailing control
  // may carry a slop that reaches into that gap from the other side, so a
  // title slop there made one strip of the row two ambiguous targets (measured
  // on the session screen: 10.33 dp across, in every state and every gate
  // cell). The box already carries the full target height
  // (`HEADER_TITLE_TARGET_CLASS`); the vertical slop only widens the row's own
  // padding, where nothing else is pressable. RN does not mirror hitSlop under
  // RTL, so a side slop also had to be spelled per direction — with none, the
  // touch area is the same box in both directions.
  const titleHitSlop = { top: 13, bottom: 13 };

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
        ellipsizeMode={titleEllipsizeMode}
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
        className={cn(HEADER_TITLE_TARGET_CLASS, 'justify-center active:opacity-70')}
      >
        {titleText}
      </Pressable>
    ) : (
      titleText
    );
  }

  // A centered title shares its row with the leading and trailing controls.
  // A spacer opposite the back control keeps the title centered on the full
  // width without placing either control out of flow.
  const separateHeading = centerTitle && (Boolean(title) || Boolean(eyebrow));

  // One decision for two cells: the heading lays the subtitle under its title
  // and the leading column lays a zero-ink twin of that same line under its
  // band, so the column always measures what the heading measures.
  const hasSubtitleLine = Boolean(subtitle) || reserveSubtitle || Boolean(subtitlePlaceholder);

  // The title and the leading control share one band, so the caret has a real
  // 48 x 48 dp box inside its parent instead of a target clipped by a 24.8 dp
  // line, and the two cells measure the same height at every font scale (see
  // `titleBandClass`). Only a non-centred header that draws a back control has
  // that column; without one the heading keeps the tree — and the height — it
  // has always had, so the band class never applies and no wrapper is added.
  const hasBackControl = canGoBack && !separateHeading;
  const bandClass = cn('justify-center', hasBackControl && titleBandClass(size, titleLines));

  // A one-line title is centred in the 48 dp band the caret occupies, so
  // (48 - title box) / 2 dp above it is empty by construction. Giving that
  // space back as the eyebrow's own bottom margin pulls the eyebrow a full line
  // down onto the title's ink instead of leaving it above the band's top edge,
  // and the header shrinks by the same amount. Both twins carry the very same
  // margin, so the heading and the leading column still measure the same height
  // and the caret stays centred on the title. The clamp keeps a large font
  // scale from pulling the eyebrow into the title's ink; a header with no back
  // control has no band and gets the 1.75 dp gap it has always had.
  const bandSlackDp =
    hasBackControl && titleLines === 1
      ? Math.max(0, (48 - TITLE_LINE_HEIGHT_DP[size] * fontScale) / 2)
      : 0;
  const eyebrowSpacingStyle = { marginBottom: EYEBROW_GAP_DP - bandSlackDp };

  const heading = (
    <View className="min-w-0 flex-1">
      {eyebrow || reserveEyebrow ? (
        <Eyebrow
          className={cn(centerTitle && 'text-center', !eyebrow && 'opacity-0')}
          style={eyebrowSpacingStyle}
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
          {/*
            Before the caller's label exists the slot holds the label that will
            fill it (`reservedEyebrow`), and with no label to go on it holds the
            blank filler: the eyebrow variant's line box no longer depends on the
            script (`EYEBROW_LINE_HEIGHT_DP`), so a no-ink space reserves exactly
            the height the arriving label takes. The copy stays transparent and
            hidden from assistive readers until `eyebrow` itself is set.
          */}
          {eyebrow ?? reservedEyebrow ?? blankEyebrow}
        </Eyebrow>
      ) : null}
      {hasBackControl ? <View className={bandClass}>{titleNode}</View> : titleNode}
      {hasSubtitleLine ? (
        <View className={cn('mt-0.5', centerTitle && 'items-center')}>
          {subtitle === undefined && subtitlePlaceholder ? (
            // The reserved text below still holds the line's height, so the
            // placeholder is painted over it rather than sizing the slot.
            <View
              className={cn(
                'absolute inset-0 justify-center',
                centerTitle ? 'items-center' : 'items-start'
              )}
              pointerEvents="none"
            >
              {subtitlePlaceholder}
            </View>
          ) : null}
          <Text
            variant="muted"
            className={cn(centerTitle && 'text-center', !subtitle && 'opacity-0')}
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
        </View>
      ) : null}
    </View>
  );
  // The reserve, as a band rather than a box around the title: a zero-width,
  // clipped twin of the eyebrow and the title's line cap holds the header's text
  // area to one height for every line count the cap allows, so a title that
  // grows a line cannot move the body below. The visible text stays at its
  // natural height and centers on the band, which is what lines the leading
  // control up with the text rather than with the empty line the reserve keeps.
  // The twin lays out with the same eyebrow style and the same cap box as the
  // visible title, so the band follows the font scale, and it needs no measured
  // height and no line-height constant of its own (the eyebrow variant owns
  // `EYEBROW_LINE_HEIGHT_DP`, the same box for every script).
  const reservedTitleBand = reserveTitleSpace ? (
    <View className="w-0 overflow-hidden" aria-hidden>
      {eyebrow || reserveEyebrow ? (
        <Eyebrow style={eyebrowSpacingStyle}>{reservedEyebrow ?? eyebrow ?? blankEyebrow}</Eyebrow>
      ) : null}
      <View className={reservedTitleHeightClass(size, titleLines)} />
    </View>
  ) : null;

  // The leading column's pull into the gutter is a START-side margin, never a
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
  // icon button while it stays focusable and keeps the same rect and label; the
  // leading column around it carries the gutter pull.
  const backControl = canGoBack ? (
    <View className="shrink-0 overflow-hidden rounded-full">
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

  // The leading column holds one 48dp control and mirrors the heading's own
  // lines beside it — the eyebrow twin, the band the title sits in, the
  // subtitle twin — so the two cells always measure the same height and the
  // header's own height is unchanged by the control.
  //
  // The control has to live in a box of its own size. React Native hit-tests
  // inside each view's bounds, so the caret laid over the title's line in an
  // absolutely positioned overlay was reachable only across 48 x 24.8 dp — the
  // 11.6 dp above and below the title line ignored the touch — and that box
  // also crossed about 1 dp into the screen body past the header's `pb-3`. The
  // band is that box: the very `titleBandClass` string the heading wraps its
  // title in, so the caret's 48dp target sits whole inside a parent at least
  // that tall, in normal flow, with nothing positioned absolutely.
  //
  // One class for both cells is also what keeps them the same height at any
  // font scale: `min-h-[48px]` for a one-line title, the title's own reserve
  // for a deeper cap (`min-h-14` for two lines), so a name that wraps cannot
  // move the body past either cell. The twins hold the lines the heading lays
  // above and below the band, so the row's `items-center` centres the caret on
  // the TITLE BAND rather than on the eyebrow-plus-title block, which left the
  // glyph about 12dp above the title line it belongs to (the organization
  // invoices header: its eyebrow is the screen's name, its title the
  // organization's).
  //
  // The twins paint nothing (a no-break space) and reach no reader. A heading
  // with no eyebrow or subtitle lays out neither twin, and the column is then
  // just the band: the plain 48dp box the caret has always had.
  const hasEyebrowLine = Boolean(eyebrow) || reserveEyebrow;
  const leadingControl = hasBackControl ? (
    <View className="w-[48px] shrink-0 -ms-4">
      {hasEyebrowLine ? (
        <Eyebrow
          style={eyebrowSpacingStyle}
          numberOfLines={1}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {blankEyebrow}
        </Eyebrow>
      ) : null}
      <View className={bandClass}>{backControl}</View>
      {hasSubtitleLine ? (
        <Text
          variant="muted"
          className="mt-0.5"
          numberOfLines={1}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {blankEyebrow}
        </Text>
      ) : null}
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
                {leadingControl}
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
