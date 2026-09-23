import { type LucideIcon } from '@/components/ui/icons';
import { type ReactNode, useCallback, useState } from 'react';
import { type LayoutChangeEvent, type ScrollViewProps, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { useCenteredStateBand } from '@/components/centered-state-band';
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
   *  measures the band it is given and compacts on its own. */
  compact?: boolean;
};

type EmptyStateContentProps = EmptyStateProps & {
  compact: boolean;
  /** Measures the rendered form. Set by the centered path only. */
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Hides the form until the layout under it belongs to it. Centered path only. */
  pendingLayout?: boolean;
};

function EmptyStateContent({
  icon: Icon,
  title,
  description,
  className,
  action,
  placement = 'center',
  iconContainerClassName = DEFAULT_ICON_CONTAINER_CLASS,
  iconSize = 24,
  iconStrokeWidth = 1.5,
  titleAccessibilityRole,
  compact,
  onLayout,
  pendingLayout = false,
}: Readonly<EmptyStateContentProps>) {
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'items-center px-6',
        compact ? 'gap-1' : 'gap-4',
        placement === 'top' && 'pt-16',
        pendingLayout && 'opacity-0',
        className
      )}
      onLayout={onLayout}
      accessibilityElementsHidden={pendingLayout || undefined}
      importantForAccessibility={pendingLayout ? 'no-hide-descendants' : undefined}
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
}

/**
 * Reads the measured band from the `CenteredState` it renders inside and picks
 * the full or the compact form from it and from the full form's own measured
 * height: a band that cannot hold the full form renders the compact one — the
 * icon is decorative, and keeping it pushed the description and the action
 * behind the bottom overlay (landscape spot defect e8: the Agents "No sessions
 * match" state in a 360pt landscape window, whose band above the tab bar is
 * ~97pt).
 *
 * The full form's height is measured, not assumed: it grows with Dynamic Type,
 * with a title or description that wraps, and with the pull-to-refresh line
 * `CenteredState` renders above these children, all of which a fixed estimate
 * misses. Only the rendered form can be measured, so the height is kept while
 * the compact form shows and refreshed the next time the full form renders —
 * a changed band, text scale, or window size.
 *
 * Kept separate from `EmptyState` so the `placement="top"` form, which is not
 * centered, always keeps the full form.
 */
function CenteredEmptyStateContent(props: Readonly<EmptyStateProps>) {
  const band = useCenteredStateBand();
  const [fullHeight, setFullHeight] = useState<number | null>(null);
  const [compact, setCompact] = useState(false);
  const [measuredCompact, setMeasuredCompact] = useState<boolean | null>(null);

  const shouldCompact = fullHeight !== null && band !== null && band < fullHeight;
  if (shouldCompact !== compact) {
    // Adjust during render: the switched form has to commit with `pendingLayout`
    // set, so the frame that still carries the other form's height stays blank
    // instead of placing the new form where the old one measured.
    setCompact(shouldCompact);
    setMeasuredCompact(null);
  }

  const measureForm = useCallback(
    (event: LayoutChangeEvent) => {
      if (!compact) {
        setFullHeight(event.nativeEvent.layout.height);
      }
      setMeasuredCompact(compact);
    },
    [compact]
  );

  const pendingLayout = fullHeight !== null && measuredCompact !== compact;

  return (
    <EmptyStateContent
      {...props}
      compact={compact}
      onLayout={measureForm}
      pendingLayout={pendingLayout}
    />
  );
}

/**
 * Renders the empty state centered inside a measured `CenteredState` by
 * default, choosing between the full and the compact form from the band that
 * state offers. A caller that measures its own clear region (`compact` passed)
 * owns that decision instead, so the form it renders cannot disagree with the
 * reserve it set on its `StateSurfaceInsets`.
 */
export function EmptyState({
  refreshControl,
  placement = 'center',
  compact,
  ...props
}: Readonly<EmptyStateProps>) {
  if (compact !== undefined) {
    return placement === 'center' ? (
      <CenteredState refreshControl={refreshControl}>
        <EmptyStateContent {...props} compact={compact} />
      </CenteredState>
    ) : (
      <EmptyStateContent {...props} placement={placement} compact={compact} />
    );
  }
  return placement === 'center' ? (
    <CenteredState refreshControl={refreshControl}>
      <CenteredEmptyStateContent {...props} />
    </CenteredState>
  ) : (
    <EmptyStateContent {...props} placement={placement} compact={false} />
  );
}
