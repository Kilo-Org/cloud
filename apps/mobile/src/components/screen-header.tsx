import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { DirectionalChevronLeft } from '@/components/ui/directional-icons';
import { I18nManager, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useOfflineBannerSpace } from '@/components/offline-banner-space';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { offlineHeaderReservation } from '@/lib/offline-banner-state';
import { cn } from '@/lib/utils';

/**
 * Top padding a modal header keeps above the native sheet's edge, clear of the
 * grabber. A sheet is its own window: the OS reports the inset it needs there
 * (zero for an inset card, the status-bar height for an edge-to-edge sheet), so
 * the header keeps this fixed clearance on iOS and Android alike instead of
 * re-adding the app window's safe-area inset.
 */
const MODAL_HEADER_TOP_PADDING = 32;

type ScreenHeaderProps = {
  /** Omit to render a bare back-button bar (e.g. when the screen body provides its own title). */
  title?: string;
  titleContent?: React.ReactNode;
  titleNumberOfLines?: number;
  /** Reserve two title lines so state changes do not move the screen body. */
  reserveTitleSpace?: boolean;
  /** Optional mono-uppercase line above the title. */
  eyebrow?: string;
  reserveEyebrow?: boolean;
  centerTitle?: boolean;
  /** Use Focus's large 30px H1 style (list roots). Default 18px (detail). */
  size?: 'default' | 'large';
  headerRight?: React.ReactNode;
  /** Home, Agents, Quick Chat, and session headers supply context below the title.
   * Other callers keep their existing title-only layout when this slot is absent. */
  context?: React.ReactNode;
  modal?: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  /** Keep Back available without history, replacing the current route with this destination. */
  backFallback?: Href;
  onTitlePress?: () => void;
  /**
   * Accessibility label for the pressable title. Defaults to a generic
   * "Open menu" so list callers don't have to supply one. Detail screens
   * (e.g. session rename) should override with a verb that describes the
   * action, not "open menu".
   */
  onTitlePressAccessibilityLabel?: string;
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

export function ScreenHeader({
  title,
  titleContent,
  titleNumberOfLines = 2,
  reserveTitleSpace = false,
  eyebrow,
  reserveEyebrow = false,
  size = 'default',
  headerRight,
  context,
  modal,
  centerTitle = modal ?? false,
  showBackButton,
  onBack,
  backFallback,
  onTitlePress,
  onTitlePressAccessibilityLabel,
  backIcon,
  safeAreaTop = true,
  className,
}: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const canGoBack = showBackButton ?? (router.canGoBack() || backFallback !== undefined);
  const isOfflineBannerVisible = useOfflineBannerSpace();

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

  // Landscape side safe areas (notch/Dynamic Island, Android cutouts) shift the
  // whole chrome off the sensor. They go on an inner wrapper so they ADD to the
  // `px-4` gutter: an inline padding on the container would beat the className
  // (inline style wins in React Native) and swallow the gutter, pulling the
  // back control's `-ms-4` chevron back inside the sensor area. Zero insets
  // collapse the wrapper style to `undefined`, so portrait geometry is
  // byte-identical and a rotation never moves anything vertically. Side padding
  // applies to every caller — a sheet with `safeAreaTop={false}` still runs
  // edge-to-edge horizontally and must clear the cutout too.
  const sideInsetStyle =
    insets.left > 0 || insets.right > 0
      ? {
          ...(insets.left > 0 ? { paddingLeft: insets.left } : undefined),
          ...(insets.right > 0 ? { paddingRight: insets.right } : undefined),
        }
      : undefined;

  // When `backIcon` isn't specified, fall back to the historical behaviour
  // where iOS modals get a ChevronDown and everything else gets a ChevronLeft.
  const resolvedBackIcon = backIcon ?? (modal && Platform.OS === 'ios' ? 'close' : 'back');

  const titleClass =
    size === 'large'
      ? 'shrink text-[30px] font-bold tracking-tight text-foreground'
      : 'shrink text-lg font-semibold text-foreground';

  // The slop widens the title into the free space beside it. RN does not mirror
  // hitSlop under RTL, so the physical right slop would reach across the
  // visually mirrored back control and the title (the later sibling) would win
  // those taps — spell the free side per direction instead.
  const titleHitSlop = I18nManager.isRTL
    ? { top: 13, right: 0, bottom: 13, left: 13 }
    : { top: 13, right: 13, bottom: 13, left: 0 };

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
        numberOfLines={titleNumberOfLines}
        ellipsizeMode="tail"
        accessibilityRole="header"
      >
        {title}
      </Text>
    );
    const titleLayout = reserveTitleSpace ? (
      <View className={cn(size === 'large' ? 'min-h-[72px]' : 'min-h-14', 'justify-center')}>
        {titleText}
      </View>
    ) : (
      titleText
    );
    // Title caret removed: rename stays available via the pressable title
    // itself. The backIcon === 'close' ChevronDown on the back control is
    // unrelated and stays.
    titleNode = onTitlePress ? (
      <Pressable
        onPress={onTitlePress}
        hitSlop={titleHitSlop}
        accessibilityRole="button"
        accessibilityLabel={
          onTitlePressAccessibilityLabel ??
          (title ? t('screenHeader.openMenuFor', { title }) : t('screenHeader.openMenu'))
        }
        className="active:opacity-70"
      >
        {titleLayout}
      </Pressable>
    ) : (
      titleLayout
    );
  }

  const heading = (
    <View className="min-w-0 flex-1">
      {eyebrow || reserveEyebrow ? (
        <Eyebrow
          className={cn('mb-0.5', centerTitle && 'text-center', !eyebrow && 'opacity-0')}
          numberOfLines={1}
          ellipsizeMode="tail"
          accessible={Boolean(eyebrow)}
          accessibilityElementsHidden={!eyebrow}
          importantForAccessibility={eyebrow ? 'auto' : 'no-hide-descendants'}
        >
          {eyebrow ?? '\u00A0'}
        </Eyebrow>
      ) : null}
      {titleNode}
      {context}
    </View>
  );
  // A centered title shares its row with the leading and trailing controls.
  // A spacer opposite the back control keeps the title centered on the full
  // width without placing either control out of flow.
  const separateHeading = centerTitle && (Boolean(title) || Boolean(eyebrow));

  // The leading control's pull into the gutter is a START-side margin, never a
  // hand-picked `mr` under RTL. With `I18nManager.doLeftAndRightSwapInRTL` on
  // (the default) React Native rewrites margin Left/Right to Yoga Start/End
  // before layout (YogaLayoutableShadowNode `swapLeftAndRightInYogaStyleProps`),
  // so `-mr-4` under RTL becomes a negative END margin — the side facing the
  // title — and the heading (the next sibling, whose interactive title fills
  // it) starts 12 points under the back control's 44-point target. Measured on
  // the row: the title box covered 0.27 of the back target's area, and the
  // explorer's `overlapping_controls` scan reports above 0.25. A
  // `marginInlineStart` is resolved to Yoga Start in both directions, so `-ms-4`
  // pulls the control into the gutter and leaves the 4-point `gap-1` intact.
  const backControl = canGoBack ? (
    <Pressable
      onPress={() => {
        if (onBack) {
          onBack();
        } else if (backFallback !== undefined && !router.canGoBack()) {
          router.replace(backFallback);
        } else {
          router.back();
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={resolvedBackIcon === 'close' ? t('common.close') : t('common.goBack')}
      className={cn(
        'h-11 w-11 shrink-0 items-center justify-center active:opacity-70',
        !separateHeading && '-ms-4'
      )}
    >
      {resolvedBackIcon === 'close' ? (
        <ChevronDown size={24} color={colors.foreground} />
      ) : (
        <DirectionalChevronLeft size={24} color={colors.foreground} />
      )}
    </Pressable>
  ) : null;
  const centeredControls =
    separateHeading && backControl && !headerRight ? (
      <View className="h-11 w-11 shrink-0" accessibilityElementsHidden pointerEvents="none" />
    ) : null;

  // The trailing cluster sizes to its content and never shrinks (`shrink-0`).
  // The previous `max-w-[50%] shrink` cap clamped the cluster's box on narrow
  // screens (a 360 dp viewport gives the session header's PR badge + metrics
  // pill cluster just 180 dp) while the fixed-width children kept painting at
  // their full width — the last control's glyphs ran past the right screen
  // edge and were cut off (device capture, session-compose-kbup). Content
  // sizing moves the squeeze to the title: `heading` is `min-w-0 flex-1`, so
  // a long title truncates in place and the controls stay whole inside the
  // screen's own padding. The widest current cluster (PR badge + pill,
  // ~190 dp) fits beside the 44 dp back control on the narrowest supported
  // viewport (320 dp), so the title always keeps space to draw in.
  //
  // Content sizing gives a variable-width label nothing to shrink against, so
  // a `headerRight` action whose width grows with its copy must bound itself
  // with its own max-w cap. PR review's Submit review (pr-review-screen.tsx)
  // and the Security Agent settings Save button (settings-save-button.tsx)
  // each carry a 140 dp cap; an uncapped one pushes the whole cluster past the
  // screen edge at large font scales (#6328) or squeezes the flex-1 title to
  // zero on a long catalog label.
  return (
    <View className={cn('bg-background px-4 pb-3', className)} style={safeAreaStyle}>
      <View style={sideInsetStyle}>
        {separateHeading ? (
          <View className="min-h-11 flex-row items-center">
            {backControl}
            <View className="min-w-0 flex-1 flex-row items-center justify-center">{heading}</View>
            {headerRight ? <View className="ms-3 shrink-0">{headerRight}</View> : centeredControls}
          </View>
        ) : (
          <View className="flex-row items-center">
            <View className="min-w-0 flex-1 flex-row items-center gap-1">
              {backControl}
              {heading}
            </View>
            {headerRight ? <View className="ms-3 shrink-0">{headerRight}</View> : null}
          </View>
        )}
      </View>
    </View>
  );
}
