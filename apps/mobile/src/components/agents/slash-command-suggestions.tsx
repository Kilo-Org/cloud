import { type SlashCommandInfo } from 'cloud-agent-sdk';
import { Pressable, ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text';

type SlashCommandSuggestionsProps = {
  commands: SlashCommandInfo[];
  onSelect: (command: SlashCommandInfo) => void;
};

/**
 * Slash command suggestions rendered inline directly above the chat composer.
 *
 * The list is a sibling of the TextInput, not a modal/overlay — tapping a row
 * commits the chosen command back into the composer's existing uncontrolled
 * input via the `onSelect` callback. Rows are 44pt tall to satisfy the
 * platform touch-target minimum and announce their command via accessibility
 * labels.
 */
export function SlashCommandSuggestions({
  commands,
  onSelect,
}: Readonly<SlashCommandSuggestionsProps>) {
  if (commands.length === 0) {
    return null;
  }

  return (
    <ScrollView
      className="max-h-48 border-t border-border bg-card"
      keyboardShouldPersistTaps="handled"
    >
      {commands.map(command => (
        <Pressable
          key={command.name}
          onPress={() => {
            onSelect(command);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Use /${command.name}`}
          accessibilityHint={command.description ?? undefined}
          hitSlop={4}
          className="min-h-[44px] flex-row items-center justify-between gap-3 border-b border-black/5 px-4 py-2 active:bg-muted dark:border-white/5"
        >
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">/{command.name}</Text>
            {command.description ? (
              <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                {command.description}
              </Text>
            ) : null}
          </View>
          <Text className="text-xs text-muted-foreground">Insert</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
