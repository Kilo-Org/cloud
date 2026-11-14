import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyBarEditorSheet } from '@/components/ssh/session/key-bar-editor-sheet';
import { ClipboardPaste, KeyboardOff, ScrollText } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { visibleKeyBarKeys } from '@/lib/ssh/key-bar';
import {
  altSequence,
  controlSequence,
  keySequence,
  MODIFIER_LETTERS,
  type TerminalKeyId,
} from '@/lib/ssh/terminal-keys';
import { useKeyBarLayout } from '@/lib/ssh/use-key-bar-layout';
import { cn } from '@/lib/utils';

/** The size a bar key paints; its own node carries Android's 48dp floor. */
const KEY_BOX_CLASS = 'h-[48px] min-w-[48px] items-center justify-center rounded-md px-3';

const ROW_CLASS = 'flex-row items-center border-border bg-card border-t';

type Modifier = 'ctrl' | 'alt';

type TerminalKeyBarProps = Readonly<{
  disabled: boolean;
  initialEditing?: boolean;
  onSend: (text: string) => void;
  onPaste: () => void;
  onSnippets: () => void;
  onHideKeyboard: () => void;
}>;

/**
 * The keys the software keyboard does not have.
 *
 * Ctrl and Alt are sticky: pressing one turns the row into letters, and the
 * next letter is sent with the modifier held (the terminal has no way to hold a
 * key across the soft keyboard, so the modifier and the letter are one
 * gesture). Pressing the modifier again cancels it.
 *
 * Paste keeps its own slot past the scrolling keys, because it is the key a
 * phone needs most and the row is wider than the screen; the scroller is sized
 * so the next key is always partly visible, which is what says there is more.
 *
 * The keys and their order are this device's: a long press on the bar opens the
 * editor, which writes the layout the bar reads on the next session.
 */
export function TerminalKeyBar({
  disabled,
  initialEditing = false,
  onSend,
  onPaste,
  onSnippets,
  onHideKeyboard,
}: TerminalKeyBarProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [modifier, setModifier] = useState<Modifier | null>(null);
  const [editorOpen, setEditorOpen] = useState(initialEditing);
  const keyBar = useKeyBarLayout();
  const { bottom } = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const bottomInset = useAnimatedStyle(
    () => ({ height: interpolate(progress.value, [0, 1], [bottom, 0], Extrapolation.CLAMP) }),
    [bottom]
  );

  const editBar = {
    onLongPress: () => {
      setEditorOpen(true);
    },
    accessibilityHint: t('ssh.keyBar.editHint'),
  };

  function press(id: TerminalKeyId) {
    if (id === 'ctrl' || id === 'alt') {
      setModifier(current => (current === id ? null : id));
      return;
    }
    onSend(keySequence(id));
  }

  function pressLetter(letter: string) {
    if (modifier === 'ctrl') {
      onSend(controlSequence(letter));
    } else if (modifier === 'alt') {
      onSend(altSequence(letter));
    }
    setModifier(null);
  }

  return (
    <>
      <View className={ROW_CLASS}>
        {modifier === null ? (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              className="flex-1"
              contentContainerClassName="flex-row items-center gap-1 py-1 pl-2"
            >
              {visibleKeyBarKeys(keyBar.layout).map(key => (
                <Pressable
                  key={key.id}
                  {...editBar}
                  onPress={() => {
                    press(key.id);
                  }}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={key.label}
                  accessibilityState={{ disabled }}
                  className={cn(
                    KEY_BOX_CLASS,
                    'bg-secondary active:opacity-70',
                    disabled && 'opacity-50'
                  )}
                >
                  <Text variant="mono" className="text-sm text-foreground">
                    {key.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View className="my-2 w-px self-stretch bg-border" />
            <View className="flex-row items-center gap-1 py-1 pl-1 pr-2">
              <Pressable
                {...editBar}
                onPress={onSnippets}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('ssh.snippets.title')}
                accessibilityState={{ disabled }}
                className={cn(
                  KEY_BOX_CLASS,
                  'bg-secondary active:opacity-70',
                  disabled && 'opacity-50'
                )}
              >
                <ScrollText size={18} color={colors.foreground} />
              </Pressable>
              <Pressable
                {...editBar}
                onPress={onPaste}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t('ssh.session.paste')}
                accessibilityState={{ disabled }}
                className={cn(
                  KEY_BOX_CLASS,
                  'bg-secondary active:opacity-70',
                  disabled && 'opacity-50'
                )}
              >
                <ClipboardPaste size={18} color={colors.foreground} />
              </Pressable>
              <Pressable
                {...editBar}
                onPress={onHideKeyboard}
                accessibilityRole="button"
                accessibilityLabel={t('ssh.session.hideKeyboard')}
                className={cn(KEY_BOX_CLASS, 'bg-secondary active:opacity-70')}
              >
                <KeyboardOff size={18} color={colors.foreground} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              className="flex-1"
              contentContainerClassName="flex-row items-center gap-1 py-1 pl-2"
            >
              <Pressable
                onPress={() => {
                  setModifier(null);
                }}
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                className={cn(KEY_BOX_CLASS, 'bg-primary active:opacity-70')}
              >
                <Text variant="mono" className="text-sm text-primary-foreground">
                  {modifier === 'ctrl' ? 'Ctrl' : 'Alt'}
                </Text>
              </Pressable>
              {MODIFIER_LETTERS.map(letter => (
                <Pressable
                  key={letter}
                  onPress={() => {
                    pressLetter(letter);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={letter}
                  className={cn(KEY_BOX_CLASS, 'bg-secondary active:opacity-70')}
                >
                  <Text variant="mono" className="text-sm text-foreground">
                    {letter}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}
      </View>
      <Animated.View className="bg-card" style={bottomInset} />
      <KeyBarEditorSheet
        visible={editorOpen}
        state={keyBar}
        onClose={() => {
          setEditorOpen(false);
        }}
      />
    </>
  );
}
