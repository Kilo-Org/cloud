import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { useTranslatedToolSummary } from '@/lib/tool-summary-translation/use-translated-tool-summary';
import { cn } from '@/lib/utils';

import {
  getSlashCommandDescription,
  type MobileSlashCommandInfo,
} from './chat-composer-slash-commands';

/**
 * Runtime slash-command descriptions share the tool-summary translation
 * runtime, so the id must not collide with a tool-part id: the prefix keeps
 * the slash menu's key space disjoint.
 */
const SLASH_COMMAND_ITEM_PREFIX = 'slash-command:';

type SlashCommandSuggestionsProps = {
  commands: MobileSlashCommandInfo[];
  onSelect: (command: SlashCommandInfo) => void;
};

type SlashCommandSuggestionRowProps = {
  command: MobileSlashCommandInfo;
  isLast: boolean;
  onSelect: (command: SlashCommandInfo) => void;
};

/**
 * One command row. The app's catalogue localizes a description it accounts for
 * (`getSlashCommandDescription`), and a description that comes from outside it
 * — MCP, skill, and other runtime commands — goes through the same translation
 * runtime as a transcript tool summary. The reserved local commands carry
 * `catalogueDescription` and are already in the app language, so they never
 * reach the gateway. The row is a fixed 44pt touch target with a single-line
 * description, so swapping the source text for its translation cannot move
 * layout.
 */
function SlashCommandSuggestionRow({
  command,
  isLast,
  onSelect,
}: Readonly<SlashCommandSuggestionRowProps>) {
  const { t } = useTranslation();
  const sourceDescription = getSlashCommandDescription(command);
  // The catalogue resolves the commands it accounts for, so the text it returns
  // then differs from the raw reported description. Everything it leaves
  // untouched is runtime text the catalogue cannot know, so it translates.
  const isRuntimeDescription =
    command.catalogueDescription !== true && sourceDescription === command.description;
  const description = useTranslatedToolSummary(
    sourceDescription ?? '',
    isRuntimeDescription,
    SLASH_COMMAND_ITEM_PREFIX + command.name
  );

  return (
    <Pressable
      onPress={() => {
        onSelect(command);
      }}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.slashCommands.useCommand', { command: command.name })}
      accessibilityHint={sourceDescription ? description : undefined}
      hitSlop={4}
      className={cn(
        'min-h-[44px] flex-row items-center justify-between gap-3 px-4 py-2 active:bg-muted',
        !isLast && 'border-b border-border'
      )}
    >
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">/{command.name}</Text>
        {sourceDescription ? (
          <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
      <Text className="text-xs text-muted-foreground">{t('agentChat.slashCommands.insert')}</Text>
    </Pressable>
  );
}

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
      {commands.map((command, index) => (
        <SlashCommandSuggestionRow
          key={command.name}
          command={command}
          isLast={index === commands.length - 1}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}
