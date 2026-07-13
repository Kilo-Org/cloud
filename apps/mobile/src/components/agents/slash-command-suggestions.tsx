import { type SlashCommandInfo } from 'cloud-agent-sdk';
import { Pressable, ScrollView } from 'react-native';

import { Text } from '@/components/ui/text';

type SlashCommandSuggestionsProps = {
  commands: SlashCommandInfo[];
  onSelect: (command: SlashCommandInfo) => void;
};

export function SlashCommandSuggestions({
  commands,
  onSelect,
}: Readonly<SlashCommandSuggestionsProps>) {
  if (commands.length === 0) {
    return null;
  }

  return (
    <ScrollView
      className="max-h-48 border-b border-border px-3 py-1"
      keyboardShouldPersistTaps="handled"
    >
      {commands.map(command => (
        <Pressable
          key={command.name}
          onPress={() => {
            onSelect(command);
          }}
          className="rounded-md px-3 py-2 active:bg-neutral-200 active:opacity-70 dark:active:bg-neutral-700"
          accessibilityRole="button"
          accessibilityLabel={`Use /${command.name}`}
        >
          <Text className="text-sm font-semibold">/{command.name}</Text>
          {command.description ? (
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
              {command.description}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}
