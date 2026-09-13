import { useSyncExternalStore } from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { ChevronDown } from '@/components/ui/icons';
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
import { branchPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

type RepositoryBranchSelectorProps = {
  /** The resolved selected repository row; `null` renders nothing. */
  repository: NewSessionRepository | null;
  disabled: boolean;
};

/** One height for every state, so the row never moves as branches arrive. */
const ROW_HEIGHT = 'h-12';

/**
 * Note rows carry full sentences, so they start at the trigger height and
 * grow with their text instead of clipping it — the same guidance must fit
 * in every language, not just English.
 */
const NOTE_MIN_HEIGHT = 'min-h-12';

/**
 * Branch row under the repository selector. The provider's default branch is
 * preselected and marked; picking another one records a checkout override for
 * exactly this repository (see `setSelectedBranchOverride`), which
 * `useNewSessionCreator` sends as `upstreamBranch`.
 *
 * The picker itself is the standard formSheet route (`agent-chat/branch-picker`),
 * like the repo/mode/model pickers: an opaque sheet with the dismiss controls
 * in its header and the rows below them. The trigger publishes the branches to
 * the picker slot and dismisses the keyboard, so the sheet never floats over
 * the form translucently or under the keyboard.
 *
 * The interactive states render at the same height as the trigger row, so the
 * section below never jumps between loading, branches, and a retryable error.
 * A note row is at least that tall and grows to show its whole message.
 */
export function RepositoryBranchSelector({
  repository,
  disabled,
}: Readonly<RepositoryBranchSelectorProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const branches = useRepositoryBranches(repository);
  const branchState = useSyncExternalStore(
    subscribeNewSessionBranchState,
    getNewSessionBranchState
  );
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
        className={cn(
          NOTE_MIN_HEIGHT,
          'justify-center rounded-lg border border-border bg-card px-3 py-2'
        )}
      >
        <Text className="text-sm text-muted-foreground">{message}</Text>
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
        onPress={openPicker}
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

  function openPicker() {
    if (!repository || disabled) {
      return;
    }
    // The keyboard belongs to the form; the sheet must not slide up over an
    // open keyboard (the form keeps first responder across taps).
    Keyboard.dismiss();
    branchPickerSlot.set(UNFENCED_ROUTE_KEY, {
      branches: branches.branches,
      defaultBranch: branches.defaultBranch,
      selectedBranch,
      onSelect: branch => {
        // The provider default is stored as "no override", so the create body
        // only carries `upstreamBranch` for a real, non-default choice.
        setSelectedBranchOverride(repository, branch === branches.defaultBranch ? null : branch);
      },
    });
    router.push('/(app)/agent-chat/branch-picker' as Href);
  }
}
