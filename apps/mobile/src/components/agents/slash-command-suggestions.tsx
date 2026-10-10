import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { FlashList } from '@shopify/flash-list';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { type ThemeColors, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTranslatedToolSummary } from '@/lib/tool-summary-translation/use-translated-tool-summary';
import { cn } from '@/lib/utils';

import {
  getSlashCommandDescription,
  isCatalogueSlashCommand,
  type MobileSlashCommandInfo,
} from './chat-composer-slash-commands';

/**
 * Runtime slash-command descriptions share the tool-summary translation
 * runtime, so the id must not collide with a tool-part id: the prefix keeps
 * the slash menu's key space disjoint.
 */
const SLASH_COMMAND_ITEM_PREFIX = 'slash-command:';

// FlashList needs a concrete viewport; maxHeight alone collapses this inline list.
// Each description row fits within 56 points; longer rows remain scrollable.
const MAX_MENU_HEIGHT = 192;
const MENU_ROW_HEIGHT = 56;

/** The menu frame plus the themed card background and top border. */
function menuStyle(colors: ThemeColors, count: number): ViewStyle {
  return {
    height: Math.min(MAX_MENU_HEIGHT, count * MENU_ROW_HEIGHT),
    flex: 0,
    backgroundColor: colors.card,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  };
}

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
 * runtime as a transcript tool summary. A catalogue-accounted row is already in
 * the app language, so it never reaches the gateway. The row is a fixed 44pt
 * touch target with a single-line description, so swapping the source text for
 * its translation cannot move layout.
 */
function SlashCommandSuggestionRow({
  command,
  isLast,
  onSelect,
}: Readonly<SlashCommandSuggestionRowProps>) {
  const { t } = useTranslation();
  const sourceDescription = getSlashCommandDescription(command);
  // Only the reported text the catalogue does not account for is runtime text
  // it cannot know, so only that text translates. Comparing the resolved
  // string with the reported one would miss the English case, where the
  // catalogue string the CLI reports is identical to the resolved string.
  const isRuntimeDescription = !isCatalogueSlashCommand(command);
  const description = useTranslatedToolSummary(
    sourceDescription ?? '',
    isRuntimeDescription,
    SLASH_COMMAND_ITEM_PREFIX + command.name
  );
  // A skill row is marked so the user can tell it apart from a plain command.
  const isSkill = command.source === 'skill';

  return (
    <Pressable
      onPress={() => {
        onSelect(command);
      }}
      accessibilityRole="button"
      accessibilityLabel={t(
        isSkill ? 'agentChat.slashCommands.useSkillCommand' : 'agentChat.slashCommands.useCommand',
        { command: command.name }
      )}
      accessibilityHint={sourceDescription ? description : undefined}
      hitSlop={4}
      className={cn(
        'min-h-[44px] flex-row items-center justify-between gap-3 px-4 py-2 active:bg-muted',
        !isLast && 'border-b border-border'
      )}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
            {`/${command.name}`}
          </Text>
          {isSkill ? (
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                {t('agentChat.slashCommands.skillBadge')}
              </Text>
            </View>
          ) : null}
        </View>
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
 *
 * The list is virtualized because the catalog can carry up to 256 commands and
 * a row translates its description as it mounts: rendering every match would
 * fan a whole catalog out to the translation gateway for the handful of rows
 * `max-h-48` actually shows.
 */
export function SlashCommandSuggestions({
  commands,
  onSelect,
}: Readonly<SlashCommandSuggestionsProps>) {
  const colors = useThemeColors();

  if (commands.length === 0) {
    return null;
  }

  return (
    <FlashList
      style={menuStyle(colors, commands.length)}
      data={commands}
      keyExtractor={command => command.name}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item, index }) => (
        <SlashCommandSuggestionRow
          command={item}
          isLast={index === commands.length - 1}
          onSelect={onSelect}
        />
      )}
    />
  );
}
