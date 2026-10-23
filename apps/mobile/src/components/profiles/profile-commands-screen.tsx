import { useRouter } from 'expo-router';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import {
  addCommand,
  commandPosition,
  commandRowA11yLabel,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_SETUP_COMMANDS,
  moveCommand,
  nonBlankCommands,
  removeCommand,
  replaceCommand,
  sameCommands,
} from '@/components/profiles/profile-commands-model';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { ChevronDown, ChevronUp, Terminal, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAgentProfile } from '@/lib/hooks/use-agent-profiles';
import { useProfileCommandsSave } from '@/lib/hooks/use-profile-commands-save';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { ICON_TARGET_BOX_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

type CommandRow = Readonly<{ sequence: number; command: string }>;

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_COMMAND_ROWS: readonly CommandRow[] = [];

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
  const router = useRouter();
  const colors = useThemeColors();
  const profileQuery = useAgentProfile(profileId, organizationId);

  const profile = profileQuery.data;
  const serverRows = profile?.commands ?? NO_COMMAND_ROWS;
  const serverCommands = useMemo(() => serverRows.map(row => row.command), [serverRows]);

  // The screen owns the ordered list — `setCommands` replaces the whole list,
  // so a move/delete/edit works on a local copy. Refetches may replace a clean
  // list, but must not discard a draft typed after the last submitted payload.
  const [commands, setCommands] = useState<string[]>(serverCommands);
  const [syncedCommands, setSyncedCommands] = useState<string[]>(serverCommands);
  const { save, persistedRef, isSaving } = useProfileCommandsSave({
    profileId,
    organizationId,
    initialCommands: serverCommands,
  });
  // The list the screen renders right now. Back reads this, not the state a
  // handler captured, because the field's last edit may not have re-rendered.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const leavingRef = useRef(false);
  // Remount uncontrolled fields for reorders and accepted server changes;
  // their text belongs to the position, not the input instance.
  const [generation, setGeneration] = useState(0);
  if (serverCommands !== syncedCommands && !isSaving) {
    setSyncedCommands(serverCommands);
    if (sameCommands(commands, persistedRef.current) && !sameCommands(commands, serverCommands)) {
      setCommands(serverCommands);
      setGeneration(current => current + 1);
    }
    persistedRef.current = serverCommands;
  }

  const commit = (index: number) => {
    const value = commands[index]?.trim() ?? '';
    if (value.length === 0) {
      // A blank draft row is not a command: leave it local until it has text.
      return;
    }
    if (sameCommands(nonBlankCommands(commands), persistedRef.current)) {
      return;
    }
    void save(commands);
  };

  const move = (index: number, delta: number) => {
    const next = moveCommand(commands, index, delta);
    if (sameCommands(next, commands)) {
      return;
    }
    setCommands(next);
    setGeneration(current => current + 1);
    void save(next);
  };

  const remove = (index: number) => {
    const next = removeCommand(commands, index);
    if (next.length === commands.length) {
      return;
    }
    setCommands(next);
    setGeneration(current => current + 1);
    void save(next);
  };

  const add = () => {
    setCommands(addCommand(commands));
    setGeneration(current => current + 1);
  };

  /**
   * The screen has no save control, so the header arrow persists the focused
   * edit before leaving. Each pass re-reads the rendered list, so an edit made
   * during a write is saved by the same press.
   */
  const leave = async () => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- each pass persists the newest list before the next check
      const saved = await save(commandsRef.current);
      if (!saved) {
        leavingRef.current = false;
        return;
      }
      if (sameCommands(nonBlankCommands(commandsRef.current), persistedRef.current)) {
        router.back();
        return;
      }
    }
  };

  const controlClass = (disabled: boolean) =>
    cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70', disabled && 'opacity-40');

  const commandTotal = nonBlankCommands(commands).length;
  const renderCommandRow = (command: string, index: number) => {
    const isFirst = index === 0;
    const isLast = index === commands.length - 1;
    const position = commandPosition(commands, index);
    const upLabel =
      position === null ? t('profiles.moveUp') : t('profiles.moveCommandUp', { position });
    const downLabel =
      position === null ? t('profiles.moveDown') : t('profiles.moveCommandDown', { position });
    const rowHint = position === null ? undefined : commandRowA11yLabel(position - 1, commandTotal);
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
          accessibilityHint={rowHint}
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
            accessibilityLabel={upLabel}
            accessibilityHint={rowHint}
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
            accessibilityLabel={downLabel}
            accessibilityHint={rowHint}
            onPress={() => {
              move(index, 1);
            }}
          >
            <ChevronDown size={20} color={colors.mutedForeground} />
          </Pressable>
          <Pressable
            className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
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
          <Button className={STATE_ACTION_CLASS} onPress={add}>
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
      <ScreenHeader
        title={t('profiles.commandsTitle')}
        onBack={() => {
          void leave();
        }}
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {content}
      </TabScreenScrollView>
    </View>
  );
}
