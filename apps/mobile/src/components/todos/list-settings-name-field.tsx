import { useState } from 'react';
import { Pressable } from 'react-native';

import { showNamePreview } from '@/components/todos/list-settings-name-selection';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

/**
 * The name box, over the shared `Input`: an unfocused single-line Android
 * field keeps its caret wherever it last was and draws the tail of a long
 * saved name — a programmatic start selection does not scroll it (verified on
 * the emulator). While unfocused this renders a one-line `Text` preview that
 * clips the END, so the field shows the beginning of the name, matching the
 * list header; tapping or focusing swaps in the real `Input`.
 */
export function NameField(
  props: Readonly<{
    defaultValue: string;
    autoFocus: boolean;
    onChangeText: (text: string) => void;
    onSubmitEditing: () => void;
    maxLength: number;
    placeholder: string;
    accessibilityLabel: string;
  }>
) {
  const [editing, setEditing] = useState(false);
  // The live value: the preview after a blur must show the text the user
  // typed, not the name the sheet opened with.
  const [text, setText] = useState(props.defaultValue);
  if (showNamePreview({ editing, hasText: text.length > 0 })) {
    return (
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        accessibilityValue={{ text }}
        onPress={() => {
          setEditing(true);
        }}
        className="min-h-[44px] justify-center rounded-lg border border-border bg-secondary pl-3 pr-3"
      >
        <Text className="text-base text-foreground" numberOfLines={1}>
          {text}
        </Text>
      </Pressable>
    );
  }
  return (
    <Input
      {...props}
      defaultValue={text}
      onChangeText={value => {
        setText(value);
        props.onChangeText(value);
      }}
      returnKeyType="done"
      autoFocus={props.autoFocus || editing}
      className="rounded-lg border border-border bg-secondary text-base text-foreground"
      onFocus={() => {
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
      }}
    />
  );
}
