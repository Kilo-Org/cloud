import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  addCommand,
  commandRowA11yLabel,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_SETUP_COMMANDS,
  moveCommand,
  removeCommand,
  replaceCommand,
} from '@/components/profiles/profile-commands-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { ChevronDown, ChevronUp, Terminal, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAgentProfile, useAgentProfileMutations } from '@/lib/hooks/use-agent-profiles';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type CommandRow = Readonly<{ sequence: number; command: string }>;

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_COMMAND_ROWS: readonly CommandRow[] = [];

/**
 * The mutation hook toasts `error.message`; the screen only supplies a
 * fallback when the server sent nothing readable.
 */
function hasUsableMessage(error: unknown): boolean {
  return error instanceof Error && error.message.trim().length > 0;
}

function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The payload `setCommands` stores. A blank row is the draft slot `add()`
 * opens, not a command, so whitespace-only entries never reach the server.
 */
function nonBlankCommands(commands: readonly string[]): string[] {
  return commands.filter(command => command.trim().length > 0);
}

/** Content-shaped cards in the same slots as a loaded command row. */
function CommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <View key={index} className="gap-3 rounded-lg bg-secondary p-3">
          <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
          <Skeleton className="h-[44px] w-full rounded-md bg-muted-soft" />
          <View className="flex-row justify-end">
            <Skeleton className="h-11 w-32 rounded-md bg-muted-soft" />
          </View>
        </View>
      ))}
    </View>
  );
}

export function ProfileCommandsScreen({
  profileId,
  organizationId,
}: Readonly<{ profileId: string; organizationId?: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const profileQuery = useAgentProfile(profileId, organizationId);
  const { setCommands: saveCommands } = useAgentProfileMutations(organizationId);

  const profile = profileQuery.data;
  const serverRows = profile?.commands ?? NO_COMMAND_ROWS;
  const serverCommands = useMemo(() => serverRows.map(row => row.command), [serverRows]);

  // The screen owns the ordered list — `setCommands` replaces the whole list,
  // so a move/delete/edit works on a local copy. Refetches may replace a clean
  // list, but must not discard a draft typed after the last submitted payload.
  const [commands, setCommands] = useState<string[]>(serverCommands);
  const [syncedCommands, setSyncedCommands] = useState<string[]>(serverCommands);
  const persistedRef = useRef<string[]>(serverCommands);
  // Remount uncontrolled fields for reorders and accepted server changes;
  // their text belongs to the position, not the input instance.
  const [generation, setGeneration] = useState(0);
  if (serverCommands !== syncedCommands && !saveCommands.isPending) {
    setSyncedCommands(serverCommands);
    if (sameCommands(commands, persistedRef.current) && !sameCommands(commands, serverCommands)) {
      setCommands(serverCommands);
      setGeneration(current => current + 1);
    }
    persistedRef.current = serverCommands;
  }

  const persist = async (next: string[]) => {
    const payload = nonBlankCommands(next);
    // `setCommands` replaces the whole list, so an unchanged payload has
    // nothing to send — e.g. moving a draft row that carries no text.
    if (sameCommands(payload, persistedRef.current)) {
      return;
    }
    const previous = persistedRef.current;
    // Mark the list persisted before the await: a submit followed by a blur
    // (or the reverse) must not send the same list twice.
    persistedRef.current = payload;
    try {
      await saveCommands.mutateAsync({ profileId, commands: payload });
    } catch (error) {
      persistedRef.current = previous;
      if (!hasUsableMessage(error)) {
        toast.error(t('profiles.commandsSaveFailed'));
      }
    }
  };

  const commit = (index: number) => {
    const value = commands[index]?.trim() ?? '';
    if (value.length === 0) {
      // A blank draft row is not a command: leave it local until it has text.
      return;
    }
    if (sameCommands(nonBlankCommands(commands), persistedRef.current)) {
      return;
    }
    void persist(commands);
  };

  const move = (index: number, delta: number) => {
    const next = moveCommand(commands, index, delta);
    if (sameCommands(next, commands)) {
      return;
    }
    setCommands(next);
    setGeneration(current => current + 1);
    void persist(next);
  };

  const remove = (index: number) => {
    const next = removeCommand(commands, index);
    if (next.length === commands.length) {
      return;
    }
    setCommands(next);
    setGeneration(current => current + 1);
    void persist(next);
  };

  const add = () => {
    setCommands(addCommand(commands));
    setGeneration(current => current + 1);
  };

  const controlClass = (disabled: boolean) =>
    cn('h-11 w-11 items-center justify-center active:opacity-70', disabled && 'opacity-40');

  const renderCommandRow = (command: string, index: number) => {
    const isFirst = index === 0;
    const isLast = index === commands.length - 1;
    return (
      <View key={`${generation}-${index}`} className="gap-3 rounded-lg bg-secondary p-3">
        <FormField
          label={t('profiles.commandLabel')}
          defaultValue={command}
          placeholder={t('profiles.commandPlaceholder')}
          className="min-h-[44px] leading-[normal]"
          maxLength={MAX_SETUP_COMMAND_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityHint={commandRowA11yLabel(index, commands.length)}
          onChangeText={value => {
            setCommands(current => replaceCommand(current, index, value));
          }}
          onEndEditing={() => {
            commit(index);
          }}
          onSubmitEditing={() => {
            commit(index);
          }}
        />
        <View className="flex-row items-center justify-end gap-1">
          <Pressable
            className={controlClass(isFirst)}
            disabled={isFirst}
            accessibilityRole="button"
            accessibilityLabel={t('profiles.moveUp')}
            accessibilityHint={commandRowA11yLabel(index, commands.length)}
            onPress={() => {
              move(index, -1);
            }}
          >
            <ChevronUp size={20} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            className={controlClass(isLast)}
            disabled={isLast}
            accessibilityRole="button"
            accessibilityLabel={t('profiles.moveDown')}
            accessibilityHint={commandRowA11yLabel(index, commands.length)}
            onPress={() => {
              move(index, 1);
            }}
          >
            <ChevronDown size={20} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            className="h-11 w-11 items-center justify-center active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
            onPress={() => {
              remove(index);
            }}
          >
            <Trash2 size={20} color={colors.destructive} />
          </Pressable>
        </View>
      </View>
    );
  };

  let content: ReactNode = null;
  if (profileQuery.isError) {
    content = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={() => void profileQuery.refetch()}
        isRetrying={profileQuery.isRefetching}
      />
    );
  } else if (profileQuery.isPending) {
    content = <CommandsSkeleton />;
  } else if (commands.length === 0) {
    content = (
      <EmptyState
        icon={Terminal}
        title={t('profiles.commandsEmpty')}
        description={null}
        placement="top"
        action={
          <Button onPress={add}>
            <Text>{t('profiles.addCommand')}</Text>
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        {commands.map((command, index) => renderCommandRow(command, index))}
        <Button onPress={add} disabled={commands.length >= MAX_SETUP_COMMANDS}>
          <Text>{t('profiles.addCommand')}</Text>
        </Button>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profiles.commandsTitle')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </ScrollView>
    </View>
  );
}
