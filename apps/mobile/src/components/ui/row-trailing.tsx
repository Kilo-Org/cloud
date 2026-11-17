import { Fragment, type ReactNode } from 'react';
import { type AccessibilityState, Pressable, View } from 'react-native';

import { RowCheck } from '@/components/ui/row-check';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowValue, type RowValueSpec } from '@/components/ui/row-value';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { textActionTargetClass } from '@/lib/a11y/tap-target';
import { selectionHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * The trailing cell of a row. Every variant shares the row's height, so a mark,
 * a switch, a value or a text action never grows the row it sits in; a wrapper
 * that already builds its own control passes it as `node`.
 */
export type RowTrailingSpec =
  | Readonly<{ kind: 'chevron' }>
  | Readonly<{ kind: 'check'; selected: boolean; disabled?: boolean }>
  | Readonly<{
      kind: 'switch';
      value: boolean;
      onValueChange: (next: boolean) => void;
      disabled?: boolean;
      /** Test handle for the switch itself, for native E2E scripts. */
      testID?: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityState?: AccessibilityState;
      thumbColor?: string;
      trackColor?: Readonly<{ false: string; true: string }>;
    }>
  | Readonly<{ kind: 'value' } & RowValueSpec>
  | Readonly<{ kind: 'badge'; label: string }>
  | Readonly<{
      kind: 'action';
      label: string;
      onPress: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      testID?: string;
    }>
  | Readonly<{ kind: 'node'; node: ReactNode }>
  | Readonly<{ kind: 'nodes'; nodes: readonly ReactNode[] }>;

/**
 * Paints a row's trailing cell. A row without one passes `undefined`; the
 * switch keeps its own accessible node and test handle, and a text action
 * carries its own 48pt target.
 */
export function renderRowTrailing(trailing: RowTrailingSpec | undefined): ReactNode {
  if (trailing === undefined) {
    return null;
  }
  switch (trailing.kind) {
    case 'chevron': {
      return <RowChevron />;
    }
    case 'check': {
      return <RowCheck selected={trailing.selected} disabled={trailing.disabled} />;
    }
    case 'switch': {
      // The control's handlers reach the native switch as one props object;
      // listing them as JSX handler props invites the handler-naming rule to
      // read a prop pass-through as a bespoke handler.
      //
      // A flip is the person's, and every switch row answers it the same way:
      // the selection tick lives in the primitive, not in each caller. A
      // programmatic `value` update never reaches this callback, so a store
      // refresh stays silent.
      const props = {
        value: trailing.value,
        onValueChange: (next: boolean) => {
          selectionHaptic();
          trailing.onValueChange(next);
        },
        disabled: trailing.disabled,
        testID: trailing.testID,
        accessibilityLabel: trailing.accessibilityLabel,
        accessibilityHint: trailing.accessibilityHint,
        accessibilityState: trailing.accessibilityState ?? {
          disabled: Boolean(trailing.disabled),
          checked: trailing.value,
        },
        thumbColor: trailing.thumbColor,
        trackColor: trailing.trackColor,
      };
      return <Switch {...props} />;
    }
    case 'value': {
      const props = {
        text: trailing.text,
        tone: trailing.tone,
        face: trailing.face,
        shrink: trailing.shrink,
        ellipsizeMode: trailing.ellipsizeMode,
        selectable: trailing.selectable,
        direction: trailing.direction,
        accessibilityLabel: trailing.accessibilityLabel,
        className: trailing.className,
        status: trailing.status,
      };
      return <RowValue {...props} />;
    }
    case 'badge': {
      return (
        <View className="shrink-0 rounded-full border border-border bg-hair-soft px-2 py-0.5">
          <Text variant="caption">{trailing.label}</Text>
        </View>
      );
    }
    case 'action': {
      const props = {
        onPress: trailing.onPress,
        disabled: trailing.disabled,
        testID: trailing.testID,
        accessibilityRole: 'button' as const,
        accessibilityLabel: trailing.accessibilityLabel ?? trailing.label,
        accessibilityState: { disabled: Boolean(trailing.disabled) },
      };
      return (
        <Pressable
          {...props}
          className={cn('shrink-0 items-center justify-center', textActionTargetClass())}
        >
          <Text
            variant="mono"
            className={cn(trailing.disabled ? 'text-muted-foreground' : 'text-primary')}
          >
            {trailing.label}
          </Text>
        </Pressable>
      );
    }
    case 'node': {
      return trailing.node;
    }
    case 'nodes': {
      return (
        <View className="shrink-0 flex-row items-center gap-2">
          {trailing.nodes.map((node, index) => (
            <Fragment key={index}>{node}</Fragment>
          ))}
        </View>
      );
    }
    default: {
      return null;
    }
  }
}
