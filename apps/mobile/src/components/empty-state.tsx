import { type LucideIcon } from '@/components/ui/icons';
import { type ComponentType, type ReactNode } from 'react';
import { type ScrollViewProps, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { useShortCenteredBand } from '@/components/centered-state-band';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useMutedDisabledInk, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

const DEFAULT_ICON_CONTAINER_CLASS = 'h-14 w-14 rounded-full border border-border bg-card';

/** The page gutter a state draws for itself; see `inset`. */
const STATE_GUTTER_CLASS = SCREEN_GUTTER_CLASS;

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  /** Optional muted text, or a node that carries its own styling (e.g. AccessibleStatus). */
  description?: ReactNode;
  className?: string;
  /** The state's way out: one `StateAction`, in the shared state-action style
   *  and directly under the copy at the slot's one fixed gap. See `StateAction`. */
  action?: ReactNode;
  /** Where a state sits, by what shares its surface: `center` (the default) when
   *  the state is the whole surface — with its one action and nothing else above
   *  it — and `top` only when it sits under intro text or controls. `center`
   *  scrolls the content inside a measured `StateSurface`; `top` pins it to the
   *  surface top without a scroller; `static` renders the plain content for a
   *  caller that owns its own full-screen layout and cannot depend on a measured
   *  surface (the root runtime-error screen). */
  placement?: 'center' | 'top' | 'static';
  /**
   * Whether the state draws the page gutter itself. `center` renders inside a
   * `CenteredState`, whose content box carries no horizontal inset, so it
   * defaults to `'gutter'`; `top` and `static` are laid out by a caller's body
   * or card, which either insets its content already (the `SCREEN_BODY_CLASS`
   * body, a `Card`, a padded row block) or owns the surface, so they default to
   * `'none'`. A `top`/`static` state that is the full-bleed content of its
   * surface — a list's `ListEmptyComponent`, a bare `CenteredState` — passes
   * `'gutter'`. Callers never spell the inset themselves (`px-0`/`px-4`).
   */
  inset?: 'gutter' | 'none';
  refreshControl?: ScrollViewProps['refreshControl'];
  /** Overrides the icon bubble's container classes (size/shape/background). Defaults to the card-style bubble. */
  iconContainerClassName?: string;
  /** Overrides the glyph color. Defaults to the muted token, which reads a step
   *  dimmer on a near-black dark tile than on the light one; a caller that keeps
   *  the illustration as visible as its light cell passes its own token. */
  iconColor?: string;
  iconSize?: number;
  iconStrokeWidth?: number;
  /** Set to 'header' when the title acts as the screen's heading (QueryError does). */
  titleAccessibilityRole?: 'header';
  /** Title classes for the compact form only, which drops the icon bubble. A
   *  caller whose state the icon would otherwise carry — an error — tints the
   *  title here so the short form keeps the cue. */
  compactTitleClassName?: string;
  /** Renders the short presentation (no icon bubble, tighter block gaps, and
   *  no top pin air above a `top`-placed stack) for a caller whose clear region
   *  cannot hold the full height; the title, the description and the action all
   *  stay. When omitted, the centered form reads the band the `CenteredState`
   *  around it publishes and compacts on its own, so the form cannot disagree
   *  with the reserve the caller set. */
  compact?: boolean;
};

export function EmptyState({
  placement = 'center',
  refreshControl,
  compact,
  title,
  ...props
}: Readonly<EmptyStateProps>) {
  const body = <EmptyStateBody {...props} title={title} placement={placement} compact={compact} />;
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
  inset = placement === 'center' ? 'gutter' : 'none',
  compact: compactOverride,
  iconContainerClassName = DEFAULT_ICON_CONTAINER_CLASS,
  iconColor,
  iconSize = 24,
  iconStrokeWidth = 1.5,
  titleAccessibilityRole,
  compactTitleClassName,
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
  // out by their own caller and keep the full stack, unless the caller says
  // the band is short: then the top pin's fixed air goes too, because 64pt of
  // it is a band's whole height when a footer above the tab bar already owns
  // the rest of a landscape window.
  //
  // A caller that measured its own clear region passes `compact` and owns the
  // decision (the Agents screen does); otherwise the centered form reads the
  // band the scroller publishes.
  const shortBand = useShortCenteredBand();
  const compact = compactOverride ?? (placement === 'center' && shortBand);

  const content = (
    <View
      className={cn(
        'items-center',
        inset === 'gutter' && STATE_GUTTER_CLASS,
        placement === 'top' && !compact && 'pt-16',
        className
      )}
    >
      <View className={cn('items-center', compact ? 'gap-2' : 'gap-4')}>
        {compact ? null : (
          <View className={cn('items-center justify-center', iconContainerClassName)}>
            <Icon
              size={iconSize}
              color={iconColor ?? colors.mutedForeground}
              strokeWidth={iconStrokeWidth}
            />
          </View>
        )}
        <View className="items-center gap-1">
          <Text
            variant="large"
            className={cn('text-center', compact ? compactTitleClassName : undefined)}
            accessibilityRole={titleAccessibilityRole}
            // A centered title is short and often narrower than the words allow:
            // Android's default greedy wrap leaves the last word alone on its own
            // line (the compact connect-gate title did). Balanced splits the title
            // into even lines instead. Android-only; iOS ignores the prop.
            textBreakStrategy="balanced"
          >
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
      </View>
      {/* The slot's one gap above the action, the same for the full and the
          compact form, so the action never floats at a caller's chosen distance. */}
      {action ? <View className="pt-3">{action}</View> : null}
    </View>
  );

  return content;
}

/**
 * The glyph a state's action carries: any icon component that draws at a size
 * and in a colour. Wider than `LucideIcon` so a brand mark (`GitHubIcon`) can
 * fill the slot too, while the action still owns the metrics around it.
 */
type StateActionIcon = ComponentType<{ size?: number; color?: string }>;

type StateActionProps = {
  label: string;
  /** The action's cue: `Plus` creates, `RotateCcw` retries, `ArrowLeft` goes back. */
  icon: StateActionIcon;
  onPress: () => void;
  /** The action is running: only the leading icon becomes a spinner and presses are ignored. */
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  /** Overrides the announced name when the visible label is not the whole action. */
  accessibilityLabel?: string;
  /** Extra context a name cannot carry, e.g. what the retry re-reads. */
  accessibilityHint?: string;
};

/**
 * The one way a state's `action` slot is filled: the primary, compact,
 * label-sized button, with its leading icon centred together with the label and
 * the shared 48pt state-action floor. Callers own nothing visual — the slot
 * above owns the gap, and this component owns the style — so no state can
 * invent a full-width, outlined or shadowed way out.
 *
 * `loading` is a busy state, not a different face of the control: the label and
 * its strength never change while the request runs, only the leading icon
 * becomes a spinner, so a retry stays readable as "the same action, working"
 * instead of collapsing to a ring. The button announces the wait, reports
 * itself disabled, and refuses presses until it clears.
 */
export function StateAction({
  label,
  icon: Icon,
  onPress,
  loading,
  disabled,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: Readonly<StateActionProps>) {
  const colors = useThemeColors();
  const mutedDisabledInk = useMutedDisabledInk();
  const busy = Boolean(loading);
  // A busy action keeps its enabled face — the brand fill and the label ink the
  // button paints on it (`Button` never dims or mutes a control that announces
  // busy) — so its mark must take that same ink. The muted ink is only for the
  // disabled face, whose fill is the palette's muted surface; on the brand fill
  // it measures about 1.4:1 and the spinner all but disappears.
  const markColor = disabled === true && !busy ? mutedDisabledInk : colors.primaryForeground;
  return (
    <Button
      size="sm"
      className={STATE_ACTION_CLASS}
      disabled={Boolean(disabled) || busy}
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy }}
      onPress={() => {
        if (busy) {
          return;
        }
        onPress();
      }}
    >
      {busy ? (
        <ActivityIndicator size={16} color={markColor} accessible={false} />
      ) : (
        <Icon size={16} color={markColor} />
      )}
      <Text>{label}</Text>
    </Button>
  );
}
