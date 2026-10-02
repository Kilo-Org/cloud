import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type AccessibilityActionEvent, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { glanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { SessionRow } from '@/components/ui/session-row';
import { prefetchSessionTranscript } from '@/lib/agent-session-cache';
import { type AgentSessionSortBy, getAgentSessionTimestamp } from '@/lib/agent-session-sort';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import { resolveSessionPrPressTarget } from '@/lib/session-pr-navigation';
import {
  namedSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  useUserSessionTitlesRevision,
} from './session-detail-rename-state';
import {
  composeSessionProvenanceSubtitle,
  composeStoredSessionSpokenMeta,
  composeStoredSessionVisibleMeta,
  formatMeta,
  formatScheduledWake,
  formatSessionTotalCost,
  storedSessionEyebrowLabel,
} from './session-list-helpers';
import { selectRowPlatformPresentation, SessionPlatformIcon } from './session-platform-icon';
import { openSessionPreviewStore } from './session-preview-state';
import {
  formatSpokenCost,
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';

/** Container shape only. `'list'` (default) keeps the Agents list look
 * (`stripMode="inline"`, inner padding so the strip sits inside the
 * padding). `'card'` mirrors the Home card look (`stripMode="edge"`,
 * `last` so no divider, no inner padding so the strip meets the
 * rounded tile border). Content flags (`live`, `needsInput`,
 * `subtitle`, `meta`, `metaWhileLive`) are passed identically in both. */
export type RowVariant = 'list' | 'card';

/**
 * Opens a session's associated PR through the provider-aware, flag-aware route.
 * The native router and browser imports are lazy: they cannot load under the
 * mounted row tests' node environment, and only the long-press entry reaches
 * them.
 */
async function openSessionPr(url: string | null | undefined, label: string): Promise<void> {
  const target = await resolveSessionPrPressTarget({ url });
  if (target.kind === 'in-app') {
    const { router } = await import('expo-router');
    router.push(target.href);
    return;
  }
  const { openExternalUrl } = await import('@/lib/external-link');
  await openExternalUrl(target.url, { label });
}

type StoredSessionRowProps = {
  session: {
    session_id: string;
    title: string | null;
    git_url: string | null;
    cloud_agent_session_id: string | null;
    created_on_platform: string;
    created_at: string;
    updated_at: string;
    git_branch: string | null;
    status: string | null;
    status_updated_at: string | null;
    /**
     * ISO-8601 wake time for a `scheduled` session, when the row carries one.
     * Stored history rows have no wake time today (the column does not exist),
     * so it is optional and the row falls back to the `SCHEDULED` label alone.
     */
    scheduledAt?: string | null;
    total_cost_microdollars: number | null;
    associatedPr?: { number: number; url?: string | null } | null;
  };
  /**
   * Which timestamp drives the row's relative meta label. The list
   * section the session lands in and the timestamp shown here are
   * both computed from this same field, so the two never contradict.
   */
  sortBy: AgentSessionSortBy;
  onPress: () => void;
  onDelete?: () => void;
  onRename?: (newTitle: string) => void;
  /** Container shape: see `RowVariant`. Defaults to `'list'`. */
  variant?: RowVariant;
  /**
   * Whether the row is fully interactive. `false` removes the long-press
   * preview (and gates any rename/delete/copy-id actions it owns).
   * Tap is preserved either way. Defaults to `true`.
   */
  interactive?: boolean;
  /**
   * Forwarded to the base `SessionRow` live dot. Defaults to `false` for
   * callers that do not supply liveness.
   */
  live?: boolean;
  /**
   * Forwarded to the base `SessionRow` meta-while-live opt-in. Defaults to
   * `false` so existing call sites are unchanged.
   */
  metaWhileLive?: boolean;
};

export function StoredSessionRow({
  session,
  sortBy,
  onPress,
  onDelete,
  onRename,
  variant = 'list',
  interactive = true,
  live = false,
  metaWhileLive = false,
}: Readonly<StoredSessionRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  // The backend names an unnamed session with a raw ISO placeholder
  // ("New session - 2026-09-22T02:05:22.778Z"); it is not a name the user
  // should see. `namedSessionTitle` uses the shared display helper and keeps
  // a placeholder-shaped title saved by a user. The subscription repaints
  // the row once the durable record hydrates after a cold start.
  useUserSessionTitlesRevision();
  const title =
    namedSessionTitle(session.title, session.session_id) ?? t('agents.sessionRow.untitled');
  // Seed Rename with the same visible title. The server's creation-default
  // title is hidden; a placeholder-shaped title saved by a user is retained.
  // Both save paths refuse an unchanged or blank value.
  const renameInitialValue = namedSessionTitle(session.title, session.session_id) ?? '';
  const agentLabel = storedSessionEyebrowLabel(session);
  const timestamp = getAgentSessionTimestamp(session, sortBy);
  const canManage = interactive && Boolean(onDelete) && Boolean(onRename);
  // The scheduled branch keys off the status, not the `live` flag: a stored
  // history row with status `scheduled` reads SCHEDULED (label only) rather
  // than Idle. A stored row has no wake time today, so `scheduledWake` is null
  // and the label carries no clock time.
  const isScheduled = session.status === 'scheduled';
  const scheduledWake =
    isScheduled && session.scheduledAt ? formatScheduledWake(session.scheduledAt) : null;

  const revision = useSessionAttentionRevision();
  const raiseId = session.status_updated_at ?? session.status ?? null;
  const needsInput = shouldShowNeedsInput({
    status: session.status,
    raiseId,
    isAcked: isAttentionAcked(session.session_id, raiseId),
  });
  useEffect(() => {
    reconcileSessionAttention(session.session_id, session.status, session.status_updated_at);
  }, [session.session_id, session.status, session.status_updated_at, revision]);

  const statusKind = session.status === null ? null : glanceableStatusKind(session.status);

  const handleLongPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    showSessionActionMenu({
      showActionSheetWithOptions,
      themedSheet,
      onCopySessionId: () => {
        void copySessionId(session.session_id);
      },
      onViewPr: session.associatedPr
        ? () => {
            void openSessionPr(session.associatedPr?.url, t('common.pullRequest'));
          }
        : undefined,
      onRename: onRename
        ? () => {
            if (Platform.OS === 'ios') {
              showRenamePrompt(renameInitialValue, newTitle => {
                onRename(newTitle);
              });
            } else {
              setRenameVisible(true);
            }
          }
        : undefined,
      onDelete: onDelete
        ? () => {
            showDeleteConfirm(onDelete);
          }
        : undefined,
    });
  };

  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'manage') {
      handleLongPress();
    }
  };

  // Visible and spoken meta mirror `formatMeta(timestamp)`. When `needsInput`
  // wins, the right eyebrow shows `NEEDS INPUT` and meta is NOT rendered.
  // When a cost is present, both forms fold it in first (matches the row's
  // "$0.12 · time" order). Needs-input sessions have no persisted cost. A
  // scheduled row shows `SCHEDULED · <wake>` instead, so its spoken meta is
  // the wake (null on a stored row, which carries none).
  const visibleMeta = composeStoredSessionVisibleMeta(
    formatSessionTotalCost(session.total_cost_microdollars),
    formatMeta(timestamp)
  );
  const storedSpokenMeta = needsInput
    ? null
    : composeStoredSessionSpokenMeta(
        formatSpokenCost(session.total_cost_microdollars),
        formatSpokenTimeAgo(timestamp)
      );
  // A scheduled row shows `SCHEDULED · <wake>` instead of the timestamp meta,
  // so it speaks the wake (null on a stored row, which carries none).
  const spokenMeta = isScheduled ? scheduledWake : storedSpokenMeta;

  // Provenance subtitle: list rows show "branch · #N", card rows keep the
  // branch-only subtitle. The spoken label mirrors this: branch text plus
  // the "pull request N" phrase, with the PR phrase only on the list variant.
  const subtitle =
    variant === 'card'
      ? session.git_branch
      : composeSessionProvenanceSubtitle({
          branch: session.git_branch,
          prNumber: session.associatedPr?.number,
        });
  const spokenPrNumber = variant === 'card' ? null : (session.associatedPr?.number ?? null);

  // Platform icon only on the Agents list variant, and only while the
  // eyebrow draws no status glyph (a glyph beside the status mark
  // reads as a stray second mark). A scheduled row draws its Clock, so it
  // suppresses the platform mark and the spoken origin with it. Home cards
  // stay byte-identical (platformIcon defaults to undefined).
  const { iconKind: platformIconKind, spokenPlatform: a11yPlatform } =
    selectRowPlatformPresentation({
      platform: session.created_on_platform,
      variant,
      needsInput,
      statusGlyph: live || isScheduled,
      gitUrl: session.git_url,
    });
  const platformIcon =
    platformIconKind != null ? (
      <View accessible={false} testID={`platform-icon-${platformIconKind}`}>
        <SessionPlatformIcon
          platform={session.created_on_platform}
          size={12}
          color={colors.mutedSoft}
        />
      </View>
    ) : undefined;

  const handlePressIn = canManage
    ? () => {
        void prefetchSessionTranscript(
          queryClient,
          trpc.cliSessionsV2.getSessionMessages.queryOptions({ session_id: session.session_id })
        );
      }
    : undefined;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onLongPress={canManage ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={sessionRowAccessibilityLabel({
        title,
        needsInput,
        live: variant === 'list' && live,
        // Only the scheduled kind is named here: other stored rows keep the
        // static LIVE word / no status word, unchanged.
        statusKind: isScheduled ? 'scheduled' : null,
        badge: agentLabel,
        meta: spokenMeta,
        subtitle: session.git_branch,
        prNumber: spokenPrNumber,
        platform: a11yPlatform,
      })}
      accessibilityActions={
        canManage ? [{ name: 'manage', label: t('agents.sessionRow.actions') }] : undefined
      }
      onAccessibilityAction={canManage ? handleAccessibilityAction : undefined}
      className="active:opacity-70"
    >
      <SessionRow
        agentLabel={agentLabel}
        title={title}
        subtitle={subtitle}
        meta={visibleMeta}
        live={live}
        statusKind={statusKind}
        scheduledWake={scheduledWake}
        metaWhileLive={metaWhileLive}
        needsInput={needsInput}
        platformIcon={platformIcon}
        stripMode={variant === 'card' ? 'edge' : 'inline'}
        last={variant === 'card' ? true : undefined}
        className={variant === 'card' ? undefined : 'pl-[22px] pr-[22px]'}
      />
    </Pressable>
  );
}
