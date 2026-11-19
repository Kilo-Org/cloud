import { Fragment, type ReactNode } from 'react';
import { type AccessibilityState, Pressable, View } from 'react-native';

import { RowCheck } from '@/components/ui/row-check';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowValue, type RowValueSpec } from '@/components/ui/row-value';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP,
  textActionRowOverhangDp,
  textActionTargetClass,
  TOUCH_TARGET_OVERHANG_DP,
} from '@/lib/a11y/tap-target';
import { selectionHaptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * The vertical margin a row's `Switch` cancels. The native control keeps
 * `TOUCH_TARGET_DP` on its own node (see `switch.tsx`), because a control-size
 * audit reads that node's rect and `hitSlop` does not lift a smaller box.
 * Hosting it without this margin made the control, not `ROW_FRAME_CLASS`, set
 * the row's height: a one-line switch row measured 65.1pt beside the 54.1pt of
 * a two-line chevron row in the 2026-11-18 gate dump. The negative margin is
 * `(TOUCH_TARGET_DP - 32) / 2` a side, so the node
 * contributes the compact box to layout and overlaps the row's own 10.5pt
 * vertical padding, which keeps every touch inside the row's bounds (Android
 * drops a touch outside a parent view).
 */
const SWITCH_BOX_STYLE = {
  marginVertical: -TOUCH_TARGET_OVERHANG_DP,
} as const;

/**
 * The vertical margin a row's text action cancels, the switch's own
 * cancellation at the action's target. The action keeps the platform's target
 * on its own node (see `textActionTargetClass`), because a control-size audit
 * reads that node's rect; the margin takes the overhang back out of the frame's
 * height, so a row with a text action lays out on the same line as the plain
 * row beside it and a group does not grow when one of its rows swaps the action
 * for a button. The node still sits inside the row's own `py-3` padding, which
 * is what keeps its touches inside the row's bounds (Android delivers a touch
 * only inside a parent view).
 */
function textActionBoxStyle() {
  return { marginVertical: -textActionRowOverhangDp() };
}

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
      /**
       * Replaces the derived disabled-only state. An action whose work is in
       * flight passes its own, so the cell announces `busy` while it keeps the
       * label and the name that say what is running.
       */
      accessibilityState?: AccessibilityState;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      testID?: string;
    }>
  | Readonly<{ kind: 'node'; node: ReactNode }>
  | Readonly<{ kind: 'nodes'; nodes: readonly ReactNode[] }>;

/**
 * Paints a row's trailing cell. A row without one passes `undefined`; the
 * switch keeps its own accessible node and test handle, and a text action
 * carries its own platform target (44pt on iOS, 48dp on Android), which its
 * margin cancels out of the row's height.
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
        style: SWITCH_BOX_STYLE,
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
        accessibilityHint: trailing.accessibilityHint,
        accessibilityState: trailing.accessibilityState ?? {
          disabled: Boolean(trailing.disabled),
        },
      };
      return (
        <Pressable
          {...props}
          style={textActionBoxStyle()}
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
      // The controls sit 17.5pt apart, so the 8pt reach each side of the
      // neighbouring hit slops (16pt together) stay clear of one another: a tap
      // between two controls belongs to the gap, never to one of them.
      return (
        <View className="shrink-0 flex-row items-center gap-5">
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

type RowIconActionProps = Readonly<{
  /** The control's spoken name; the icon carries no text of its own. */
  label: string;
  /** Extra context a name cannot carry, e.g. the item's place in a list. */
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  /** Test handle for native E2E scripts. */
  testID?: string;
  children: ReactNode;
}>;

/**
 * An icon-only control for a row's trailing cell: the shared compact box, whose
 * touch region reaches 48pt through `hitSlop` rather than through its frame, so
 * an edit, reorder or delete control never makes its row taller than the chevron
 * row beside it (`RowFrame`'s one geometry).
 */
export function RowIconAction({
  label,
  hint,
  onPress,
  disabled,
  testID,
  children,
}: RowIconActionProps) {
  const props = {
    onPress,
    disabled,
    testID,
    accessibilityRole: 'button' as const,
    accessibilityLabel: label,
    accessibilityHint: hint,
    accessibilityState: disabled === undefined ? undefined : { disabled },
  };
  return (
    <Pressable
      {...props}
      className={cn(
        COMPACT_CONTROL_BOX_CLASS,
        'shrink-0 active:opacity-70',
        disabled === true && 'opacity-40'
      )}
      hitSlop={COMPACT_CONTROL_HIT_SLOP}
    >
      {children}
    </Pressable>
  );
}
