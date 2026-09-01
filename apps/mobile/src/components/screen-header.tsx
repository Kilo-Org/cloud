import { type Href, useRouter } from 'expo-router';
import { ChevronDown } from '@/components/ui/icons';
import { DirectionalChevronLeft } from '@/components/ui/directional-icons';
import { I18nManager, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Eyebrow } from '@/components/ui/eyebrow';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type ScreenHeaderProps = {
  /** Omit to render a bare back-button bar (e.g. when the screen body provides its own title). */
  title?: string;
  titleContent?: React.ReactNode;
  titleNumberOfLines?: number;
  /** Optional mono-uppercase line above the title. */
  eyebrow?: string;
  reserveEyebrow?: boolean;
  centerTitle?: boolean;
  contextPosition?: 'below' | 'right';
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
  /** Extra classes on the outer header container. Overrides the default `px-4` for screens that need a different horizontal inset. */
  className?: string;
};

export function ScreenHeader({
  title,
  titleContent,
  titleNumberOfLines = 2,
  eyebrow,
  reserveEyebrow = false,
  size = 'default',
  headerRight,
  context,
  contextPosition = 'below',
  modal,
  centerTitle = modal ?? false,
  showBackButton,
  onBack,
  backFallback,
  onTitlePress,
  onTitlePressAccessibilityLabel,
  backIcon,
  className,
}: Readonly<ScreenHeaderProps>) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const canGoBack = showBackButton ?? (router.canGoBack() || backFallback !== undefined);
  const hasRightContext = contextPosition === 'right' && Boolean(context);

  // iOS modals are presented as cards already inset from the status bar
  const paddingTop = modal && Platform.OS === 'ios' ? 32 : insets.top + 8;

  // When `backIcon` isn't specified, fall back to the historical behaviour
  // where iOS modals get a ChevronDown and everything else gets a ChevronLeft.
  const resolvedBackIcon = backIcon ?? (modal && Platform.OS === 'ios' ? 'close' : 'back');

  const titleClass =
    size === 'large'
      ? 'shrink text-[30px] font-bold tracking-tight text-foreground'
      : 'shrink text-lg font-semibold text-foreground';

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
        className={cn(titleClass, centerTitle && 'text-center', hasRightContext && 'shrink-0')}
        numberOfLines={titleNumberOfLines}
        ellipsizeMode="tail"
        accessibilityRole="header"
      >
        {title}
      </Text>
    );
    // Title caret removed: rename stays available via the pressable title
    // itself. The backIcon === 'close' ChevronDown on the back control is
    // unrelated and stays.
    titleNode = onTitlePress ? (
      <Pressable
        onPress={onTitlePress}
        hitSlop={{ top: 13, right: 13, bottom: 13, left: 0 }}
        accessibilityRole="button"
        accessibilityLabel={
          onTitlePressAccessibilityLabel ??
          (title ? t('screenHeader.openMenuFor', { title }) : t('screenHeader.openMenu'))
        }
        className="active:opacity-70"
      >
        {titleText}
      </Pressable>
    ) : (
      titleText
    );
  }

  const heading = (
    <View className={cn('min-w-0', hasRightContext && !centerTitle ? 'flex-none' : 'flex-1')}>
      {eyebrow || reserveEyebrow ? (
        <Eyebrow
          className={cn('mb-0.5', centerTitle && 'text-center', !eyebrow && 'opacity-0')}
          accessible={Boolean(eyebrow)}
          accessibilityElementsHidden={!eyebrow}
          importantForAccessibility={eyebrow ? 'auto' : 'no-hide-descendants'}
        >
          {eyebrow ?? '\u00A0'}
        </Eyebrow>
      ) : null}
      {titleNode}
      {contextPosition === 'below' && context}
    </View>
  );
  const separateHeading = centerTitle && (Boolean(title) || Boolean(eyebrow));

  return (
    <View className={cn('bg-background px-4 pb-3', className)} style={{ paddingTop }}>
      {separateHeading && <View className="min-h-11 flex-row items-center">{heading}</View>}
      <View className="flex-row items-center">
        <View
          className={cn(
            'min-w-0 flex-row items-center gap-1',
            hasRightContext ? 'flex-none' : 'flex-1'
          )}
        >
          {canGoBack && (
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
              accessibilityLabel={
                resolvedBackIcon === 'close' ? t('screenHeader.close') : t('screenHeader.goBack')
              }
              className={`${I18nManager.isRTL ? '-mr-4' : '-ml-4'} h-11 w-11 shrink-0 items-center justify-center active:opacity-70`}
            >
              {resolvedBackIcon === 'close' ? (
                <ChevronDown size={24} color={colors.foreground} />
              ) : (
                <DirectionalChevronLeft size={24} color={colors.foreground} />
              )}
            </Pressable>
          )}
          {!separateHeading && heading}
        </View>
        {hasRightContext ? <View className="ms-6 min-w-0 flex-1 items-end">{context}</View> : null}
        {headerRight ? (
          <View className={`${I18nManager.isRTL ? 'mr-3' : 'ml-3'} min-w-0 max-w-[50%] shrink`}>
            {headerRight}
          </View>
        ) : null}
      </View>
    </View>
  );
}
