import { type Href, usePreventRemove, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ProfileCommandRowControls } from '@/components/profiles/profile-command-row-controls';
import {
  addCommand,
  commandRowA11yLabel,
  MAX_SETUP_COMMANDS,
  moveCommand,
  nonBlankCommands,
  removeCommand,
  replaceCommand,
  sameCommands,
} from '@/components/profiles/profile-commands-model';
import { CommandsSkeleton } from '@/components/profiles/profile-commands-skeleton';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { SetupCommandField } from '@/components/profiles/setup-command-field';
import { ProfileSectionHeader } from '@/components/profiles/profile-section-header';
import { QueryError } from '@/components/query-error';
import { TabScreenScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Terminal } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useAgentProfileCommands } from '@/lib/hooks/use-agent-profiles';
import { useOrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { useProfileCommandsSave } from '@/lib/hooks/use-profile-commands-save';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearFormDraft, useFormDraftState } from '@/lib/form-draft';
import { COMMAND_ROW_FIELD_GAP_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

type CommandRow = Readonly<{ sequence: number; command: string }>;

/** Stable empty fallback so the derived list is not a new array each render. */
const NO_COMMAND_ROWS: readonly CommandRow[] = [];

export function ProfileCommandsScreen({
  profileId,
  organizationId,
  backFallback,
}: Readonly<{
  profileId: string;
  organizationId?: string;
  /**
   * The Profiles list of the stack that mounted this screen: the screen's own
   * "no history" destination, since both the Profile tab and the app-level
   * Manage Profiles stack render it.
   */
  backFallback: Href;
}>) {
  const { t } = useTranslation();
  const router = useRouter();
  // A cold link can render this route with nothing beneath it: Back then lands
  // on the mounting stack's Profiles list instead of unwinding the stack.
  const leaveScreen = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.dismissTo(backFallback);
  }, [router, backFallback]);
  const colors = useThemeColors();
  const commandsQuery = useAgentProfileCommands(profileId, organizationId);
  const permission = useOrganizationProfilePermission(organizationId);
  const canManage = permission === 'allowed';

  const serverRows: readonly CommandRow[] = commandsQuery.data ?? NO_COMMAND_ROWS;
  const serverCommands = useMemo(() => serverRows.map(row => row.command), [serverRows]);

  // The screen owns the ordered list — `setCommands` replaces the whole list,
  // so a move/delete/edit works on a local copy. Refetches may replace a clean
  // list, but must not discard a draft typed after the last submitted payload.
  // The list itself is a draft (`lib/form-draft`), so the rows a remount would
  // otherwise drop come back with the text that was typed into them.
  const draftScope = `profiles:commands:${profileId}`;
  // The list the draft was last reconciled with travels with the draft, so a
  // remount can tell a restored copy of server truth from unsaved edits even
  // when the query has no cached rows yet.
  const [draftBase, setDraftBase] = useFormDraftState<string[]>(draftScope, 'base', serverCommands);
  const [commands, setCommands] = useFormDraftState<string[]>(
    draftScope,
    'commands',
    serverCommands
  );
  const [syncedCommands, setSyncedCommands] = useState<string[]>(serverCommands);
  const { save, persistedRef, isSaving } = useProfileCommandsSave({
    profileId,
    organizationId,
    initialCommands: draftBase,
  });
  // The list the screen renders right now. Back reads this, not the state a
  // handler captured, because the field's last edit may not have re-rendered.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const leavingRef = useRef(false);
  // Latched once the newest list is persisted, so the replay of the blocked
  // navigation action is not intercepted again.
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  // Remount uncontrolled fields for reorders and accepted server changes;
  // their text belongs to the position, not the input instance.
  const [generation, setGeneration] = useFormDraftState(draftScope, 'generation', 0);
  // The list on screen reseeds from the server only while it still holds the
  // list it was seeded from: a mount then can never replay an older copy over
  // a newer one. Unsaved edits are never replaced, and neither is a list whose
  // save has not been refetched yet, so a query with no rows yet — or the list
  // a just-settled save replaced — is not server truth here.
  const serverList = commandsQuery.data === undefined ? null : serverCommands;
  const reseed =
    !isSaving &&
    serverList !== null &&
    sameCommands(commands, draftBase) &&
    !sameCommands(draftBase, serverCommands);
  if (reseed || (serverCommands !== syncedCommands && !isSaving)) {
    setSyncedCommands(serverCommands);
    if (reseed) {
      setCommands(serverCommands);
      setGeneration(current => current + 1);
    }
    if (serverList !== null) {
      persistedRef.current = serverCommands;
      setDraftBase(serverCommands);
    }
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
   * The screen has no save control, so every leave — the header arrow, the
   * Android back button and the back gesture — persists the focused edit
   * before the screen goes. Each pass re-reads the rendered list, so an edit
   * made during a write is saved by the same attempt; the replay of the
   * blocked navigation action then leaves. A failed save stays on the screen.
   */
  const leave = async (repeat: () => void) => {
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
        // The list is server truth now, so the draft's job is done: the next
        // mount seeds from the refetched list instead of replaying it.
        clearFormDraft(draftScope);
        setLeaveAllowed(true);
        repeat();
        return;
      }
    }
  };

  /**
   * One guard covers the header arrow, the hardware back button and the back
   * gesture, because all of them remove this route. A focused, unblurred field
   * is already in `commands`, so a typed draft counts as unsaved work before
   * any blur commit; a write in flight keeps the guard on so a second back
   * waits for it instead of leaving behind an unreported failure.
   */
  const unsavedCommands = !sameCommands(nonBlankCommands(commands), persistedRef.current);
  usePreventRemove(!leaveAllowed && (unsavedCommands || isSaving), ({ repeat }) => {
    void leave(repeat);
  });

  const renderCommandRow = (command: string, index: number) => {
    const isFirst = index === 0;
    const isLast = index === commands.length - 1;
    // Every row is a command slot, so a blank draft row keeps the position it
    // occupies in the list and its controls name that command, as the saved
    // rows around it do.
    const position = index + 1;
    const upLabel = t('profiles.moveCommandUp', { position });
    const downLabel = t('profiles.moveCommandDown', { position });
    const deleteLabel = t('profiles.deleteCommand', { position });
    // The field's label is also its accessible name, so it carries the same
    // position the row's move and delete controls announce.
    const commandLabel = t('profiles.commandLabelPosition', { position });
    const rowHint = commandRowA11yLabel(index, commands.length);
    // The controls stay out of the field's accessible name and keep their own
    // positions. The controls are the card's own overlay band: the card
    // positions them, so their touch area escapes the label row's bounds (a
    // parent-bounds clip) and each control reaches 44 dp on both axes.
    const rowControls = canManage ? (
      <ProfileCommandRowControls
        color={colors.mutedForeground}
        hint={rowHint}
        upLabel={upLabel}
        downLabel={downLabel}
        deleteLabel={deleteLabel}
        canMoveUp={!isFirst}
        canMoveDown={!isLast}
        onMoveUp={() => {
          move(index, -1);
        }}
        onMoveDown={() => {
          move(index, 1);
        }}
        onDelete={() => {
          remove(index);
        }}
      />
    ) : undefined;
    return (
      // The card's 14 dp padding holds the control band's reach into the top
      // edge; see tap-target.ts for the arithmetic. The band renders after the
      // card so it paints on top of the card's opaque background and Android
      // dispatches its touches last. The field's own block carries the widened
      // label-to-field gap that keeps the band above the field.
      <View key={`${generation}-${index}`} className="relative">
        <View className="rounded-lg bg-secondary p-4">
          <SetupCommandField
            command={command}
            label={commandLabel}
            gapClassName={COMMAND_ROW_FIELD_GAP_CLASS}
            accessibilityHint={rowHint}
            readOnly={!canManage}
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
        </View>
        {rowControls}
      </View>
    );
  };

  let content: ReactNode = null;
  if (commandsQuery.isError) {
    content = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profiles.loadFailed')}
        onRetry={() => void commandsQuery.refetch()}
        isRetrying={commandsQuery.isRefetching}
      />
    );
  } else if (commandsQuery.isPending) {
    content = <CommandsSkeleton />;
  } else if (commands.length === 0) {
    content = (
      <EmptyState
        icon={Terminal}
        title={t('profiles.commandsEmpty')}
        description={null}
        placement="top"
        action={
          <ProfileManageSlot permission={permission}>
            <Button className={STATE_ACTION_CLASS} onPress={add}>
              <Text>{t('profiles.addCommand')}</Text>
            </Button>
          </ProfileManageSlot>
        }
      />
    );
  } else {
    content = (
      <>
        {commands.map((command, index) => renderCommandRow(command, index))}
        <ProfileManageSlot permission={permission}>
          {commands.length >= MAX_SETUP_COMMANDS ? (
            <AccessibleStatus
              message={t('profiles.commandLimitReached', { max: MAX_SETUP_COMMANDS })}
              tone="warn"
              className="text-sm"
            />
          ) : null}
          <Button onPress={add} disabled={commands.length >= MAX_SETUP_COMMANDS}>
            <Text>{t('profiles.addCommand')}</Text>
          </Button>
        </ProfileManageSlot>
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ProfileSectionHeader
        profileId={profileId}
        organizationId={organizationId}
        title={t('profiles.commandsTitle')}
        backFallback={backFallback}
        onBack={leaveScreen}
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
