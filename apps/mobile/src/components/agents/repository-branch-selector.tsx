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
  resolveBranchSectionState,
  setSelectedBranchOverride,
  subscribeNewSessionBranchState,
} from '@/components/agents/new-session-repository-state';
import { ROW_TARGET_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRepositoryBranches } from '@/lib/use-new-session-repos';
import { branchPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

/**
 * The chrome every branch-row state draws. It carries no height of its own, on
 * purpose. A floor here is measured against the frame's border box, and the
 * frame draws 1 dp of border on each side: a state whose content is already
 * 48 dp tall — the failed row's retry surface — came out one border taller
 * than the states whose content is a line of text, and everything below the
 * branch section moved by that border the moment the branches arrived. The
 * floor belongs on the row's content box instead (see `BRANCH_ROW_BODY_CLASS`),
 * so every state renders `48 dp + the frame's border` and no state is taller
 * than the state it replaces.
 */
const ROW_FRAME_CLASS = 'flex-row items-center gap-2 rounded-lg border border-border px-3';

/**
 * The 48 dp content box inside {@link ROW_FRAME_CLASS}. Loading, loaded, failed
 * and note rows all put their content here, so the row's height does not depend
 * on which state rendered it: the box is borderless, which makes the floor its
 * exact height at every screen density, and the frame's border is the same on
 * every state. The failed row's 48 dp retry surface sits inside this box rather
 * than beside it, so it is never clipped.
 */
const BRANCH_ROW_BODY_CLASS = ROW_TARGET_CLASS;

type RepositoryBranchSelectorProps = {
  /** The resolved selected repository row; `null` renders nothing. */
  repository: NewSessionRepository | null;
  /** The route's organization scope; `undefined` is a personal session. */
  organizationId: string | undefined;
  disabled: boolean;
};

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
 * Every state renders its content in one 48 px body inside the same bordered
 * frame (see `ROW_FRAME_CLASS`), so the section below does not jump as branches
 * arrive: the loading, loaded and failed rows are all `48 px + one border`
 * tall. The failed row's 48 dp retry action sits inside that body instead of
 * being clipped by the row's border. A note row grows past the floor to show
 * its whole message.
 */
export function RepositoryBranchSelector({
  repository,
  organizationId,
  disabled,
}: Readonly<RepositoryBranchSelectorProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const branches = useRepositoryBranches(repository, organizationId);
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
  // One discriminant drives the row: exactly one of these nodes renders.
  const section = resolveBranchSectionState({
    platform: repository.platform,
    isEnabled: branches.isEnabled,
    isLoading: branches.isLoading,
    isPermanentError: branches.isPermanentError,
    isRetryableError: branches.isRetryableError,
    isRetrying: branches.isRetrying,
    branches: branches.branches,
    defaultBranch: branches.defaultBranch,
    truncated: branches.truncated,
  });

  return (
    <View className="mt-3">
      <Text className="mb-2 text-sm font-medium text-muted-foreground">{t('common.branch')}</Text>
      {/*
        Each state is its own native view. React would otherwise recycle the
        loading wrapper — the only one that carries an accessibility label —
        into the next state's row and keep the stale "Loading branches"
        description on it, so assistive tech announced loading together with the
        error (or the list) underneath. The key makes every state a fresh view.
      */}
      <View key={section.kind}>{renderBody()}</View>
    </View>
  );

  function renderBody() {
    switch (section.kind) {
      case 'bitbucket-organizations-only': {
        // A retry could not fix it, and the row never queried: say so instead
        // of offering one.
        return renderNote(t('agentChat.newSession.bitbucketOrganizationsOnly'));
      }
      case 'loading': {
        return (
          <View
            accessible
            accessibilityLabel={t('agentChat.newSession.branchLoading')}
            className={cn(ROW_FRAME_CLASS, 'bg-secondary')}
          >
            <View className={cn(BRANCH_ROW_BODY_CLASS, 'flex-1 justify-center')}>
              {/* A branch-name line, so the placeholder reads as the row it
                  becomes instead of a block that resizes into one. */}
              <Skeleton className="h-4 w-full" />
            </View>
          </View>
        );
      }
      case 'unavailable': {
        // A refusal a retry cannot fix (no access, repository gone): explain it,
        // and leave the repository selected on its provider default.
        return renderNote(t('agentChat.newSession.branchUnavailable'));
      }
      case 'retryable': {
        return (
          <View className={cn(ROW_FRAME_CLASS, 'bg-card')}>
            <View
              className={cn(
                BRANCH_ROW_BODY_CLASS,
                'flex-1 flex-row items-center justify-between gap-2'
              )}
            >
              <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={2}>
                {t('agentChat.newSession.branchLoadError')}
              </Text>
              <Button
                variant="outline"
                size="sm"
                className={STATE_ACTION_CLASS}
                onPress={handleRetry}
                disabled={section.isRetrying}
                loading={section.isRetrying}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            </View>
          </View>
        );
      }
      case 'empty': {
        // The repository stays selected and the session starts on whatever the
        // provider checks out — there is no override to offer.
        return renderNote(t('agentChat.newSession.branchEmpty'));
      }
      case 'list': {
        return (
          <>
            {renderTrigger()}
            {/* The provider holds branches this list cannot include: say so here,
                before the sheet is opened, rather than presenting a partial list
                as the repository's whole set. */}
            {section.truncated ? (
              <View className="mt-2">
                {renderNote(t('agentChat.newSession.branchListIncomplete'))}
              </View>
            ) : null}
          </>
        );
      }
      default: {
        return null;
      }
    }
  }

  function renderNote(message: string) {
    // Note rows carry full sentences, so their body takes the shared row floor
    // and grows with its text instead of clipping it — the same guidance must
    // fit in every language, not just English.
    return (
      <View className={cn(ROW_FRAME_CLASS, 'bg-card')}>
        <View className={cn(BRANCH_ROW_BODY_CLASS, 'flex-1 justify-center py-2')}>
          <Text className="text-sm text-muted-foreground">{message}</Text>
        </View>
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
        className={cn(ROW_FRAME_CLASS, 'bg-secondary', disabled && 'opacity-50')}
      >
        <View
          className={cn(
            BRANCH_ROW_BODY_CLASS,
            'flex-1 flex-row items-center justify-between gap-2'
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
        </View>
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
      truncated: branches.truncated,
      onSelect: branch => {
        // The provider default is stored as "no override", so the create body
        // only carries `upstreamBranch` for a real, non-default choice.
        setSelectedBranchOverride(repository, branch === branches.defaultBranch ? null : branch);
      },
    });
    router.push('/(app)/agent-chat/branch-picker' as Href);
  }
}
