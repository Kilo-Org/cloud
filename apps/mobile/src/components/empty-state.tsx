import { type LucideIcon } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { type ScrollViewProps, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { useCenteredStateBand } from '@/components/centered-state-band';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const DEFAULT_ICON_CONTAINER_CLASS = 'h-14 w-14 rounded-2xl border border-border bg-card';

/**
 * Height the full centered form needs: the decorative icon bubble, the title,
 * the description, the action, and the gaps between them. A centered state
 * whose band is shorter renders the compact form — the icon is decorative and
 * keeping it pushed the description and the action behind the bottom overlay
 * (landscape spot defect e8: the Agents "No sessions match" state in a 360pt
 * landscape window, whose band above the tab bar is ~97pt).
 */
const FULL_FORM_BAND = 168;

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  /** Muted centered text, or a node that carries its own styling (e.g. AccessibleStatus). */
  description: ReactNode;
  className?: string;
  action?: ReactNode;
  placement?: 'center' | 'top';
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Overrides the icon bubble's container classes (size/shape/background). Defaults to the card-style bubble. */
  iconContainerClassName?: string;
  iconSize?: number;
  iconStrokeWidth?: number;
  /** Set to 'header' when the title acts as the screen's heading (QueryError does). */
  titleAccessibilityRole?: 'header';
};

type EmptyStateContentProps = EmptyStateProps & { compact: boolean };

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
}: Readonly<EmptyStateContentProps>) {
  const colors = useThemeColors();

  return (
    <View
      className={cn(
        'items-center px-6',
        compact ? 'gap-1' : 'gap-4',
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
}

/**
 * Reads the measured band from the `CenteredState` it renders inside and picks
 * the full or the compact form. Kept separate from `EmptyState` so the
 * `placement="top"` form, which is not centered, always keeps the full form.
 */
function CenteredEmptyStateContent(props: Readonly<EmptyStateProps>) {
  const band = useCenteredStateBand();
  return <EmptyStateContent {...props} compact={band !== null && band < FULL_FORM_BAND} />;
}

export function EmptyState({
  refreshControl,
  placement = 'center',
  ...props
}: Readonly<EmptyStateProps>) {
  return placement === 'center' ? (
    <CenteredState refreshControl={refreshControl}>
      <CenteredEmptyStateContent {...props} />
    </CenteredState>
  ) : (
    <EmptyStateContent {...props} placement={placement} compact={false} />
  );
}
