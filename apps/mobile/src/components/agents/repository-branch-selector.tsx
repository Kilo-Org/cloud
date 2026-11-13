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
import {
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useRepositoryBranches } from '@/lib/use-new-session-repos';
import { branchPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

/**
 * The frame every branch-row state draws: the same bordered box the Account,
 * Run on and Repository pickers above it render ({@link FIELD_TRIGGER_FRAME_CLASS}),
 * so the stacked trigger column has one height and one fill. It carries no
 * height of its own — a floor here is measured against the frame's border box,
 * and a state whose content is already 48 dp tall would then render one border
 * taller than the state it replaces — and no per-state background, so only the
 * row's content changes between loading, loaded, failed and note.
 */
const ROW_FRAME_CLASS = FIELD_TRIGGER_FRAME_CLASS;

/**
 * The 48 dp content box inside {@link ROW_FRAME_CLASS}
 * ({@link FIELD_TRIGGER_BODY_CLASS}). Loading, loaded, failed and note rows all
 * put their content here, so the row's height does not depend on which state
 * rendered it, and the failed row's 48 dp retry action sits inside the box
 * rather than beside it, so it is never clipped.
 */
const BRANCH_ROW_BODY_CLASS = FIELD_TRIGGER_BODY_CLASS;

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
 * Every state renders its content in the shared 48 dp trigger body inside the
 * same bordered frame the Account, Run on and Repository pickers above it draw
 * (see `ROW_FRAME_CLASS`), so the column keeps one height and nothing below the
 * section jumps as branches arrive. The failed row's 48 dp retry action sits
 * borderless inside that body, and the fill is the same `bg-secondary` on every
 * state. A note row grows past the floor to show its whole message.
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
            className={ROW_FRAME_CLASS}
          >
            <View className={BRANCH_ROW_BODY_CLASS}>
              {/* A branch-name line, so the placeholder reads as the row it
                  becomes instead of a block that resizes into one.
                  `bg-muted-soft`, not the default `bg-skeleton-fill`: in the
                  light palette that fill equals this row's `bg-secondary`, so
                  a default bar painted nothing and the loading row read as an
                  empty field (org-usage-stats.tsx reserves its value the same
                  way). `w-1/3` makes it read as a branch name, not a progress
                  bar. */}
              <Skeleton className="h-4 w-1/3 bg-muted-soft" />
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
          <View className={ROW_FRAME_CLASS}>
            <View className={cn(BRANCH_ROW_BODY_CLASS, 'justify-between')}>
              {/* The padding sits on the message, not the body: the 48 dp
                  retry already fills the floor, so body padding would make the
                  failed row taller than the others. On the message it only
                  takes effect once two large-text lines outgrow the floor. */}
              <Text className="flex-1 py-2 text-sm text-muted-foreground" numberOfLines={2}>
                {t('agentChat.newSession.branchLoadError')}
              </Text>
              {/* Borderless, so the 48 dp action fills the body without
                  drawing a second border inside the frame's. Its trailing
                  inset is cancelled by its own horizontal padding, so the
                  label sits as far from the trailing border as the message
                  does from the leading one — in either direction. */}
              <Button
                variant="ghost"
                size="sm"
                className={cn(STATE_ACTION_CLASS, '-me-3')}
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
                as the repository's whole set. It sits under a live trigger, so
                it is muted helper text with no frame of its own — a second
                bordered box there would read as another, broken picker. */}
            {section.truncated ? (
              <Text className="mt-2 text-sm text-muted-foreground">
                {t('agentChat.newSession.branchListIncomplete')}
              </Text>
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
    // Note rows carry full sentences, so their body keeps the shared row floor
    // and grows with its text instead of clipping it — the same guidance must
    // fit in every language, not just English. The `py-2` is what keeps the
    // inset when it does grow: a one-line note is centred in the 48 dp floor
    // and has slack above and below, but a three-line translation is taller
    // than that floor, and without the padding its line boxes would sit on the
    // frame's own border.
    return (
      <View className={ROW_FRAME_CLASS}>
        <View className={cn(BRANCH_ROW_BODY_CLASS, 'py-2')}>
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
        className={cn(ROW_FRAME_CLASS, disabled && 'opacity-50')}
      >
        <View className={cn(BRANCH_ROW_BODY_CLASS, 'justify-between')}>
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
