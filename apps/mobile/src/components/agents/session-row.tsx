import { useActionSheet } from '@expo/react-native-action-sheet';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { RenameModal } from '@/components/rename-modal';
import { SessionRow } from '@/components/ui/session-row';
import { type AgentSessionSortBy, getAgentSessionTimestamp } from '@/lib/agent-session-sort';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  isAttentionAcked,
  reconcileSessionAttention,
  shouldShowNeedsInput,
  useSessionAttentionRevision,
} from '@/lib/session-attention';
import {
  composeSessionProvenanceSubtitle,
  composeStoredSessionSpokenMeta,
  composeStoredSessionVisibleMeta,
  formatMeta,
  formatSessionTotalCost,
  storedSessionEyebrowLabel,
} from './session-list-helpers';
import { selectRowPlatformPresentation, SessionPlatformIcon } from './session-platform-icon';
import {
  formatSpokenCost,
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';
import {
  copySessionId,
  showDeleteConfirm,
  showRenamePrompt,
  showSessionActionMenu,
} from './session-row-actions';

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
   * manage menu (and gates any rename/delete/copy-id actions it owns).
   * Tap is preserved either way. Defaults to `true`.
   */
  interactive?: boolean;
  /**
   * Forwarded to the base `SessionRow` live dot. Defaults to `false` so
   * Home and the Agents list stay behavior-identical.
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
  const { bottom } = useSafeAreaInsets();
  const { showActionSheetWithOptions } = useActionSheet();
  const title =
    session.title && session.title.length > 0 ? session.title : t('agents.sessionRow.untitled');
  const [renameVisible, setRenameVisible] = useState(false);
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

  const handleLongPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    showSessionActionMenu({
      showActionSheetWithOptions,
      bottomInset: bottom,
      onCopySessionId: () => {
        void copySessionId(session.session_id);
      },
      onRename: onRename
        ? () => {
            if (Platform.OS === 'ios') {
              showRenamePrompt(title, newTitle => {
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

  // Platform icon only on the Agents list variant. Home cards stay
  // byte-identical (platformIcon defaults to undefined).
  const { iconKind: platformIconKind, spokenPlatform: a11yPlatform } =
    selectRowPlatformPresentation({
      platform: session.created_on_platform,
      variant,
      needsInput,
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
    <>
      <Pressable
        onPress={onPress}
        onLongPress={canManage ? handleLongPress : undefined}
        accessibilityRole="button"
        accessibilityLabel={sessionRowAccessibilityLabel({
          title,
          needsInput,
          badge: agentLabel,
          meta: spokenMeta,
          subtitle: session.git_branch,
          prNumber: spokenPrNumber,
          platform: a11yPlatform,
        })}
        className="active:opacity-70"
      >
        <SessionRow
          agentLabel={agentLabel}
          title={title}
          subtitle={subtitle}
          meta={visibleMeta}
          live={live}
          metaWhileLive={metaWhileLive}
          needsInput={needsInput}
          platformIcon={platformIcon}
          stripMode={variant === 'card' ? 'edge' : 'inline'}
          last={variant === 'card' ? true : undefined}
          className={variant === 'card' ? undefined : 'pl-[22px] pr-[22px]'}
        />
      </Pressable>

      {renameVisible && (
        <RenameModal
          title={t('agentChat.session.renameSession')}
          placeholder={t('agentChat.session.renamePlaceholder')}
          initialValue={title}
          onClose={() => {
            setRenameVisible(false);
          }}
          onSave={async name => {
            // Resolve immediately so RenameModal closes like today's list flow;
            // mutation errors toast + roll back outside the modal (r5b-3).
            onRename?.(name);
            await Promise.resolve();
          }}
        />
      )}
    </>
  );
}
