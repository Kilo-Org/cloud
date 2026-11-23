import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { AlertCircle, Download } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { TOUCH_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { isolateBidiText } from '@/lib/bidi';
import { formatList } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatTrustedImageHost } from '@/lib/hooks/use-trusted-image-hosts';
import { cn } from '@/lib/utils';

import { getLinkAccessibilityActions } from './markdown-link';

/**
 * The chips that stand in for an image the native view never fetches. Both lead
 * with the markdown alt text, because it is the only description left once the
 * picture is gone, and both answer the message's link long press exactly as the
 * loaded image does.
 */

/** Each segment becomes its own bidi run, so a right-to-left line keeps the reading order. */
function chipLine(segments: readonly (string | null)[]): string {
  return segments
    .filter((segment): segment is string => segment !== null && segment !== '')
    .map(segment => isolateBidiText(segment))
    .join(' · ');
}

/** Static chip for http and data URIs: HTTPS-only copy, host name for http. */
export function BlockedImageChip({
  kind,
  uri,
  alt,
  linkLabel,
  onPress,
  onShowLinkActions,
}: Readonly<{
  kind: 'http' | 'data';
  uri: string;
  alt: string;
  linkLabel?: string;
  onPress?: () => void;
  onShowLinkActions?: () => void;
}>) {
  const colors = useThemeColors();
  const { i18n, t } = useTranslation();
  const host = kind === 'http' ? formatTrustedImageHost(uri) : null;
  const description = alt.trim();
  const line = chipLine([description, host, t('agentChat.markdownImage.httpsOnly')]);
  // Inside a link the chip is that link's control, so its name carries the
  // link's own name the way the loaded image's name does.
  const label = linkLabel ? formatList([line, linkLabel], i18n.language) : line;
  const body = (
    <>
      <AlertCircle size={14} color={colors.mutedForeground} />
      <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={2}>
        {line}
      </Text>
    </>
  );
  const chrome =
    'flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900';
  const linkActions = onShowLinkActions ? getLinkAccessibilityActions(true) : undefined;
  // A chip with no gesture is plain content: no pressable host, so it neither
  // flashes nor grows to a touch target nobody can use.
  if (!onPress && !onShowLinkActions) {
    return (
      <View className={chrome} accessible accessibilityRole="text" accessibilityLabel={label}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onShowLinkActions}
      className={cn(TOUCH_TARGET_CLASS, chrome, onPress && 'active:opacity-80')}
      accessibilityRole={onPress ? 'link' : 'text'}
      accessibilityLabel={label}
      accessibilityActions={linkActions}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'showLinkActions') {
          onShowLinkActions?.();
        }
      }}
    >
      {body}
    </Pressable>
  );
}

/** HTTPS, not yet confirmed: source host plus a Load affordance. No Image mounts. */
export function UnconfirmedImageChip({
  uri,
  alt,
  onLoad,
  onShowLinkActions,
}: Readonly<{
  uri: string;
  alt: string;
  onLoad: () => void;
  onShowLinkActions?: () => void;
}>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const host = formatTrustedImageHost(uri);
  const reason = host ?? t('agentChat.markdownImage.httpsOnly');
  const description = alt.trim();
  const label = chipLine([description, reason]);
  const loadLabel = host
    ? t('agentChat.markdownImage.loadWithHost', { host })
    : t('agentChat.markdownImage.load');
  return (
    <Pressable
      onLongPress={onShowLinkActions}
      accessible={false}
      className="h-full flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900"
    >
      <Text accessible className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={2}>
        {label}
      </Text>
      <Pressable
        onPress={onLoad}
        onLongPress={onShowLinkActions}
        accessibilityRole="button"
        accessibilityLabel={loadLabel}
        accessibilityActions={onShowLinkActions ? getLinkAccessibilityActions(true) : undefined}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'showLinkActions') {
            onShowLinkActions?.();
          }
        }}
        className="min-h-11 min-w-11 shrink-0 flex-row items-center justify-center gap-1 px-2 active:opacity-70"
      >
        <Download size={16} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-foreground">
          {t('agentChat.markdownImage.load')}
        </Text>
      </Pressable>
    </Pressable>
  );
}
