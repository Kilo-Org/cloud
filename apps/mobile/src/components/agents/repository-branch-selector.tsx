import { useState, useSyncExternalStore } from 'react';
import { FlatList, Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Check, ChevronDown } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  getNewSessionBranchState,
  type NewSessionRepository,
  repositoryIdentityKey,
  setSelectedBranchOverride,
  subscribeNewSessionBranchState,
} from '@/components/agents/new-session-repository-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRepositoryBranches } from '@/lib/use-new-session-repos';
import { cn } from '@/lib/utils';

type RepositoryBranchSelectorProps = {
  /** The resolved selected repository row; `null` renders nothing. */
  repository: NewSessionRepository | null;
  disabled: boolean;
};

/** One height for every state, so the row never moves as branches arrive. */
const ROW_HEIGHT = 'h-12';

/**
 * Branch row under the repository selector. The provider's default branch is
 * preselected and marked; picking another one records a checkout override for
 * exactly this repository (see `setSelectedBranchOverride`), which
 * `useNewSessionCreator` sends as `upstreamBranch`.
 *
 * Every state renders at the same height as the trigger row, so the section
 * below never jumps between loading, branches, an error, and an empty list.
 */
export function RepositoryBranchSelector({
  repository,
  disabled,
}: Readonly<RepositoryBranchSelectorProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const branches = useRepositoryBranches(repository);
  const branchState = useSyncExternalStore(
    subscribeNewSessionBranchState,
    getNewSessionBranchState
  );
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const handleRetry = branches.retry;

  if (!repository) {
    return null;
  }

  const override = branchState.overrides.get(repositoryIdentityKey(repository)) ?? null;
  const selectedBranch = override ?? branches.defaultBranch;

  return (
    <View className="mt-3">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">{t('common.branch')}</Text>
      {renderBody()}
      {isPickerOpen ? renderPicker() : null}
    </View>
  );

  function renderBody() {
    if (!repository) {
      return null;
    }
    // Bitbucket is organization-only. A personal Bitbucket row never queries
    // branches, and a retry could not change that — say so instead of
    // offering one.
    if (!branches.isEnabled && repository.platform === 'bitbucket') {
      return renderNote(t('agentChat.newSession.bitbucketOrganizationsOnly'));
    }
    if (branches.isLoading || !branches.isEnabled) {
      return (
        <View accessible accessibilityLabel={t('agentChat.newSession.branchLoading')}>
          <Skeleton className={cn(ROW_HEIGHT, 'w-full')} />
        </View>
      );
    }
    // A refusal a retry cannot fix (no access, repository gone): explain it,
    // and leave the repository selected on its provider default.
    if (branches.isPermanentError) {
      return renderNote(t('agentChat.newSession.branchUnavailable'));
    }
    if (branches.isRetryableError) {
      return (
        <View
          className={cn(
            ROW_HEIGHT,
            'flex-row items-center justify-between gap-2 rounded-lg border border-border bg-card px-3'
          )}
        >
          <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={2}>
            {t('agentChat.newSession.branchLoadError')}
          </Text>
          <Button
            variant="outline"
            size="sm"
            onPress={handleRetry}
            disabled={branches.isRetrying}
            loading={branches.isRetrying}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      );
    }
    // Empty: the repository stays selected and the session starts on whatever
    // the provider checks out — there is no override to offer.
    if (branches.branches.length === 0) {
      return renderNote(t('agentChat.newSession.branchEmpty'));
    }
    return renderTrigger();
  }

  function renderNote(message: string) {
    return (
      <View
        className={cn(ROW_HEIGHT, 'justify-center rounded-lg border border-border bg-card px-3')}
      >
        <Text className="text-sm text-muted-foreground" numberOfLines={2}>
          {message}
        </Text>
      </View>
    );
  }

  function renderTrigger() {
    // A provider can list branches without naming a default (a mirror with no
    // HEAD, a repository whose default was deleted). The picker below still
    // lists every branch, so the row asks for a choice rather than claiming
    // the list is empty, and nothing is marked as the default.
    const label = selectedBranch ?? t('agentChat.newSession.branchPlaceholder');
    const isDefault = selectedBranch !== null && selectedBranch === branches.defaultBranch;
    return (
      <Pressable
        onPress={() => {
          setIsPickerOpen(true);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t('agentChat.newSession.branchAccessibility', { label })}
        accessibilityState={{ disabled }}
        className={cn(
          ROW_HEIGHT,
          'flex-row items-center justify-between gap-2 rounded-lg border border-border bg-secondary px-3',
          disabled && 'opacity-50'
        )}
      >
        <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
          {label}
        </Text>
        {isDefault ? (
          <Text className="text-xs text-muted-foreground">
            {t('agentChat.newSession.branchDefault')}
          </Text>
        ) : null}
        <ChevronDown size={14} color={colors.mutedForeground} />
      </Pressable>
    );
  }

  function renderPicker() {
    const close = () => {
      setIsPickerOpen(false);
    };
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <Pressable
          // Backdrop tap-to-dismiss. accessible={false} so it does not collapse
          // the sheet subtree into one VoiceOver node.
          accessible={false}
          className="flex-1 justify-start px-6 pt-[20%]"
          onPress={close}
        >
          <View className="absolute inset-0 bg-black opacity-50" />
          <Pressable
            // Catches taps so the list does not dismiss the sheet.
            accessible={false}
            className="max-h-[70%] gap-4 rounded-2xl bg-popover p-5"
            onPress={event => {
              event.stopPropagation();
            }}
          >
            <Text accessibilityRole="header" className="text-center text-base font-semibold">
              {t('agentChat.newSession.branchPickerTitle')}
            </Text>
            <FlatList
              data={branches.branches}
              keyExtractor={branch => branch}
              renderItem={({ item }) => renderBranchRow(item, close)}
              showsVerticalScrollIndicator={false}
            />
            <View className="flex-row justify-end">
              <Button variant="outline" onPress={close}>
                <Text>{t('common.cancel')}</Text>
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  function renderBranchRow(branch: string, close: () => void) {
    if (!repository) {
      return null;
    }
    const isSelected = branch === selectedBranch;
    const isDefault = branch === branches.defaultBranch;
    return (
      <Pressable
        className="flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-secondary"
        accessibilityRole="button"
        accessibilityState={{ selected: isSelected }}
        accessibilityLabel={t('agentChat.newSession.branchAccessibility', { label: branch })}
        onPress={() => {
          // The provider default is stored as "no override", so the create body
          // only carries `upstreamBranch` for a real, non-default choice.
          setSelectedBranchOverride(repository, isDefault ? null : branch);
          close();
        }}
      >
        <Text className="flex-1 text-sm" numberOfLines={1}>
          {branch}
        </Text>
        {isDefault ? (
          <Text className="text-xs text-muted-foreground">
            {t('agentChat.newSession.branchDefault')}
          </Text>
        ) : null}
        {isSelected ? <Check size={16} color={colors.foreground} /> : null}
      </Pressable>
    );
  }
}
