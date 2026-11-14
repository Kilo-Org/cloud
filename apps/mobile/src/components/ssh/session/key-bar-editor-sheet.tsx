import { styled } from 'nativewind';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type ScrollViewInstance, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedRef } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Sortable from 'react-native-sortables';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp, GripVertical } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
import { selectionHaptic } from '@/lib/haptics';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { canHideKeyBarKey, isDefaultKeyBarLayout, keyBarKeys } from '@/lib/ssh/key-bar';
import { type TerminalKey, type TerminalKeyId } from '@/lib/ssh/terminal-keys';
import { type KeyBarLayoutState } from '@/lib/ssh/use-key-bar-layout';
import { cn } from '@/lib/utils';

const SortableHandle = styled(Sortable.Handle, { className: 'style' });

const ROW_CLASS = 'flex-row items-center gap-1 rounded-lg bg-secondary py-1 pl-1 pr-2';

/** The tallest the list may grow before it scrolls, as a share of the window. */
const LIST_MAX_WINDOW_FRACTION = 0.5;
const LIST_MAX_HEIGHT_DP = 420;
/** Clearance under the footer, on top of the window's bottom inset. */
const FOOTER_CLEARANCE_DP = 16;

type KeyBarRowProps = Readonly<{
  terminalKey: TerminalKey;
  hidden: boolean;
  first: boolean;
  last: boolean;
  hideAllowed: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onHiddenChange: (hidden: boolean) => void;
}>;

function KeyBarRow({
  terminalKey,
  hidden,
  first,
  last,
  hideAllowed,
  onMoveUp,
  onMoveDown,
  onHiddenChange,
}: KeyBarRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className={ROW_CLASS}>
      <SortableHandle className={COMPACT_CONTROL_BOX_CLASS}>
        <GripVertical size={18} color={colors.mutedForeground} />
      </SortableHandle>
      <Text variant="mono" className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
        {terminalKey.label}
      </Text>
      <Pressable
        disabled={first}
        accessibilityRole="button"
        accessibilityLabel={t('ssh.keyBar.moveUp', { label: terminalKey.label })}
        accessibilityState={{ disabled: first }}
        hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
        className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70', first && 'opacity-40')}
        onPress={onMoveUp}
      >
        <ChevronUp size={18} color={colors.mutedForeground} />
      </Pressable>
      <Pressable
        disabled={last}
        accessibilityRole="button"
        accessibilityLabel={t('ssh.keyBar.moveDown', { label: terminalKey.label })}
        accessibilityState={{ disabled: last }}
        hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
        className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70', last && 'opacity-40')}
        onPress={onMoveDown}
      >
        <ChevronDown size={18} color={colors.mutedForeground} />
      </Pressable>
      <Switch
        value={!hidden}
        disabled={!hideAllowed}
        accessibilityLabel={t('ssh.keyBar.show', { label: terminalKey.label })}
        accessibilityHint={hideAllowed ? undefined : t('ssh.keyBar.keepOne')}
        onValueChange={visible => {
          onHiddenChange(!visible);
        }}
      />
    </View>
  );
}

type KeyBarEditorSheetProps = Readonly<{
  visible: boolean;
  state: KeyBarLayoutState;
  onClose: () => void;
}>;

/**
 * The bar's own keys, in the order the bar paints them. Dragging the grip or
 * the chevrons moves a key; its switch takes the key off the bar without
 * losing its place, except for the last key still shown.
 */
export function KeyBarEditorSheet({ visible, state, onClose }: KeyBarEditorSheetProps) {
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const scrollRef = useAnimatedRef<ScrollViewInstance>();
  const keys = useMemo(() => keyBarKeys(state.layout), [state.layout]);
  const hidden = useMemo(() => new Set<TerminalKeyId>(state.layout.hidden), [state.layout]);
  const listMaxHeight = Math.min(
    LIST_MAX_HEIGHT_DP,
    Math.round(windowHeight * LIST_MAX_WINDOW_FRACTION)
  );

  let body = null;
  if (state.status === 'loading') {
    body = (
      <View className="gap-2">
        {[0, 1, 2].map(row => (
          <Skeleton key={row} className="h-[52px] rounded-lg" />
        ))}
      </View>
    );
  } else if (state.status === 'error') {
    body = (
      <View className="items-center gap-3 py-4">
        <AccessibleStatus message={t('ssh.keyBar.loadFailed')} className="text-sm" />
        <Button
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            state.retry();
          }}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  } else {
    body = (
      <GestureHandlerRootView className="flex-none">
        {/* The app root's gesture root does not reach a sheet's native window,
            and the drag handles are gesture-handler gestures. */}
        <Animated.ScrollView
          ref={scrollRef}
          style={{ maxHeight: listMaxHeight }}
          keyboardShouldPersistTaps="handled"
        >
          <Sortable.Grid
            customHandle
            columns={1}
            data={keys}
            keyExtractor={terminalKey => terminalKey.id}
            scrollableRef={scrollRef}
            rowGap={8}
            dragActivationDelay={0}
            overDrag="vertical"
            renderItem={({ item, index }) => (
              <KeyBarRow
                terminalKey={item}
                hidden={hidden.has(item.id)}
                first={index === 0}
                last={index === keys.length - 1}
                hideAllowed={canHideKeyBarKey(state.layout, item.id)}
                onMoveUp={() => {
                  state.move(item.id, -1);
                }}
                onMoveDown={() => {
                  state.move(item.id, 1);
                }}
                onHiddenChange={next => {
                  state.setHidden(item.id, next);
                }}
              />
            )}
            onDragEnd={({ fromIndex, toIndex }) => {
              if (fromIndex === toIndex) {
                return;
              }
              selectionHaptic();
              state.moveTo(fromIndex, toIndex);
            }}
          />
        </Animated.ScrollView>
      </GestureHandlerRootView>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} dismissGestures={false}>
      <View className="gap-4 px-4 pt-2" style={{ paddingBottom: bottom + FOOTER_CLEARANCE_DP }}>
        <View className="gap-1">
          <Text
            accessibilityRole="header"
            className="text-center text-base font-semibold text-foreground"
          >
            {t('ssh.keyBar.title')}
          </Text>
          {state.status === 'ready' ? (
            <Text className="text-center text-xs text-muted-foreground">
              {t('ssh.keyBar.subtitle')}
            </Text>
          ) : null}
        </View>
        {body}
        <View className="h-px bg-border" />
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            className={cn(STATE_ACTION_CLASS, 'flex-1')}
            disabled={state.status !== 'ready' || isDefaultKeyBarLayout(state.layout)}
            onPress={() => {
              state.restoreDefault();
            }}
          >
            <Text>{t('ssh.keyBar.restoreDefault')}</Text>
          </Button>
          <Button className={cn(STATE_ACTION_CLASS, 'flex-1')} onPress={onClose}>
            <Text>{t('common.done')}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
