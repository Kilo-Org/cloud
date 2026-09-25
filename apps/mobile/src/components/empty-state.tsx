import { type LucideIcon } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { type ScrollViewProps, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { useShortCenteredBand } from '@/components/centered-state-band';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const DEFAULT_ICON_CONTAINER_CLASS = 'h-14 w-14 rounded-2xl border border-border bg-card';

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  /** Muted centered text, or a node that carries its own styling (e.g. AccessibleStatus). */
  description: ReactNode;
  className?: string;
  action?: ReactNode;
  /** `center` scrolls the content inside a measured `StateSurface`; `top`
   *  pins it to the surface top without a scroller; `static` renders the plain
   *  content for a caller that owns its own full-screen layout and cannot
   *  depend on a measured surface (the root runtime-error screen). */
  placement?: 'center' | 'top' | 'static';
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Overrides the icon bubble's container classes (size/shape/background). Defaults to the card-style bubble. */
  iconContainerClassName?: string;
  iconSize?: number;
  iconStrokeWidth?: number;
  /** Set to 'header' when the title acts as the screen's heading (QueryError does). */
  titleAccessibilityRole?: 'header';
  /** Renders the short presentation (no icon bubble, tighter block gaps) for a
   *  caller whose clear region cannot hold the full height; the title, the
   *  description and the action all stay. When omitted, the centered form
   *  reads the band the `CenteredState` around it publishes and compacts on its
   *  own, so the form cannot disagree with the reserve the caller set. */
  compact?: boolean;
};

export function EmptyState({
  placement = 'center',
  refreshControl,
  compact,
  ...props
}: Readonly<EmptyStateProps>) {
  const body = <EmptyStateBody {...props} placement={placement} compact={compact} />;
  return placement === 'center' ? (
    <CenteredState refreshControl={refreshControl}>{body}</CenteredState>
  ) : (
    body
  );
}

function EmptyStateBody({
  icon: Icon,
  title,
  description,
  className,
  action,
  placement,
  compact: compactOverride,
  iconContainerClassName = DEFAULT_ICON_CONTAINER_CLASS,
  iconSize = 24,
  iconStrokeWidth = 1.5,
  titleAccessibilityRole,
}: Readonly<EmptyStateProps>) {
  const colors = useThemeColors();
  // A centered state is handed the band between the page header and the fixed
  // bottom tab bar, and in a short landscape window that band is shorter than
  // the full stack: on a 411dp-tall window the band is ~120dp — ~49dp once the
  // FAB's own strip is reserved — against the ~167dp the bubble, the copy and
  // the action need. The stack then overflows the band, so the copy and the
  // action sit under the bar, whose overlay swallows their taps, and only a
  // scroll brings them back. The bubble is decoration: a short band drops it
  // and halves the gaps, which keeps the copy and the action inside the band
  // with no scroll. `placement="top"` and `placement="static"` states are laid
  // out by their own caller and keep the full stack.
  //
  // A caller that measured its own clear region passes `compact` and owns the
  // decision (the Agents screen does); otherwise the centered form reads the
  // band the scroller publishes.
  const shortBand = useShortCenteredBand();
  const compact = compactOverride ?? (placement === 'center' && shortBand);

  const content = (
    <View
      className={cn(
        'items-center px-6',
        compact ? 'gap-2' : 'gap-4',
        placement === 'top' && 'pt-16',
        className
      )}
    >
      {compact ? null : (
        <View className={cn('items-center justify-center', iconContainerClassName)}>
          <Icon size={iconSize} color={colors.mutedForeground} strokeWidth={iconStrokeWidth} />
        </View>
      )}
      <View className="items-center gap-1">
        <Text variant="large" accessibilityRole={titleAccessibilityRole}>
          {title}
        </Text>
        {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode has no non-typeof way to detect its plain-string variant
          typeof description === 'string' ? (
            <Text variant="muted" className="text-center">
              {description}
            </Text>
          ) : (
            description
          )
        }
      </View>
      {action}
    </View>
  );

  return content;
}
