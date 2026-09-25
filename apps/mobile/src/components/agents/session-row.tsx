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
import { useTRPC } from '@/lib/trpc';
import { namedSessionTitle, useUserSessionTitlesRevision } from './session-detail-rename-state';
import {
  composeSessionProvenanceSubtitle,
  composeStoredSessionSpokenMeta,
  composeStoredSessionVisibleMeta,
  formatMeta,
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
    total_cost_microdollars: number | null;
    associatedPr?: { number: number } | null;
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
    openSessionPreviewStore({
      sessionId: session.session_id,
      title,
      initialRenameValue: renameInitialValue,
      live,
      statusKind,
      needsInput,
      totalCostMicrodollars: session.total_cost_microdollars,
      onRename,
      onDelete,
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
  // "$0.12 · time" order). Needs-input sessions have no persisted cost.
  const visibleMeta = composeStoredSessionVisibleMeta(
    formatSessionTotalCost(session.total_cost_microdollars),
    formatMeta(timestamp)
  );
  const spokenMeta = needsInput
    ? null
    : composeStoredSessionSpokenMeta(
        formatSpokenCost(session.total_cost_microdollars),
        formatSpokenTimeAgo(timestamp)
      );

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
  // eyebrow draws no live status glyph (a glyph beside the status mark
  // reads as a stray second mark). Home cards stay byte-identical
  // (platformIcon defaults to undefined).
  const { iconKind: platformIconKind, spokenPlatform: a11yPlatform } =
    selectRowPlatformPresentation({
      platform: session.created_on_platform,
      variant,
      needsInput,
      statusGlyph: live,
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

  return (
    <Pressable
      onPress={onPress}
      onPressIn={
        canManage
          ? () => {
              void prefetchSessionTranscript(
                queryClient,
                trpc.cliSessionsV2.getSessionMessages.queryOptions({ session_id: session.session_id })
              );
            }
          : undefined
      }
      onLongPress={canManage ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={sessionRowAccessibilityLabel({
        title,
        needsInput,
        live: variant === 'list' && live,
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
