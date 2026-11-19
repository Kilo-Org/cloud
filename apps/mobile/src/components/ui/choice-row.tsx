import { type ReactNode } from 'react';

import { RowFrame } from '@/components/ui/row-frame';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { selectableRowA11y } from '@/lib/a11y/selectable-row';
import { formatList } from '@/lib/format';
import { selectionHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

type ChoiceRowProps = {
  /** Ignored when `children` is given. */
  label?: string;
  description?: string;
  /**
   * Accessible name for a row whose children spell out only part of what the
   * row means, e.g. a name followed by a decorative-only status glyph. Takes
   * precedence over the label/description composition and over the name React
   * Native derives from the child text.
   */
  accessibleName?: string;
  selected: boolean;
  /**
   * Runs the selection. Return `false` when the press does not apply — a save
   * in flight, a locked scope — and the row skips its selection tick, so the
   * haptic never announces a choice that did not happen. `void` counts as
   * applied, which keeps every existing caller unchanged.
   */
  onPress: (() => void) | (() => boolean);
  disabled?: boolean;
  /** Marks the row as busy for a11y, e.g. while its own save is in flight. */
  busy?: boolean;
  /** Android renders `accessibilityRole="checkbox"` instead of `"radio"`; iOS uses a button with the selected trait. */
  multi?: boolean;
  /** Extra classes on the row container, e.g. a divider border. */
  className?: string;
  /** Test handle for the row's own control, for native E2E scripts. */
  testID?: string;
  /**
   * Custom row content instead of the default label/description text — e.g. an
   * icon-prefixed row. A caller that supplies it owns the disabled cue: the row
   * keeps every line readable, so the caller's own label takes
   * `text-muted-foreground` while `disabled` is true.
   */
  children?: ReactNode;
};

/**
 * Shared radio/checkbox-style selection row. Owns the selection haptic —
 * callers must NOT fire their own `selectionHaptic()` on press.
 */
export function ChoiceRow({
  label,
  description,
  accessibleName,
  selected,
  onPress,
  disabled,
  busy,
  multi,
  className,
  testID,
  children,
}: Readonly<ChoiceRowProps>) {
  // A busy row needs an explicit accessible name: React Native replaces the
  // name derived from the child `Text` nodes with its own content description
  // (label + busy state) as soon as a state has no node setter, and it does
  // not restore the derived name once the state clears.
  const namedParts =
    children == null ? [label, description].flatMap(part => (part ? [part] : [])) : [];

  return (
    <RowFrame
      testID={testID}
      className={className}
      trailing={{ kind: 'check', selected, disabled }}
      disabled={disabled}
      onPress={() => {
        const applied = onPress();
        if (applied !== false) {
          selectionHaptic();
        }
      }}
      {...selectableRowA11y({
        multi: Boolean(multi),
        selected,
        disabled: Boolean(disabled),
        busy,
      })}
      accessibilityLabel={
        accessibleName ??
        (namedParts.length > 0 ? formatList(namedParts, i18n.language) : undefined)
      }
    >
      {children ?? (
        <>
          {/* The disabled cue is the label's muted token, not a row opacity: a
              caption under a dimmed row drops to roughly 2:1 on the row
              surface, and this one is read, not decorative. */}
          <Text className={cn('text-sm font-medium', disabled && 'text-muted-foreground')}>
            {label}
          </Text>
          {description ? (
            <Text variant="muted" className="mt-0.5 text-xs">
              {description}
            </Text>
          ) : null}
        </>
      )}
    </RowFrame>
  );
}
