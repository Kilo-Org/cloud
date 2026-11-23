import {
  glanceableStatusKind,
  type GlanceableStatusKind,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  isAttentionAcked,
  shouldShowNeedsInput,
  useSessionAttentionHydration,
  useSessionAttentionRevision,
} from '@/lib/session-attention';

import { formatSessionTotalCost } from './session-list-helpers';
import { type SessionPreviewTarget } from './session-preview-state';

/**
 * The DB row the preview polls while its session is live. Only the three
 * fields the header shows are named, so the polling query's own result type
 * stays the source.
 */
type SessionPreviewLiveRow = {
  status: string | null;
  status_updated_at: string | null;
  total_cost_microdollars: number | null;
};

type SessionPreviewHeaderMetaProps = {
  target: SessionPreviewTarget;
  /** Present only for a live target: the polled row wins over the target. */
  liveRow: SessionPreviewLiveRow | undefined;
};

/**
 * The header shows the row's title and cost. Live sessions show working,
 * idle, or needs input. Finished sessions do not show a live state.
 * Polling updates the state and cost while the session remains live.
 */
export function SessionPreviewHeaderMeta({
  target,
  liveRow,
}: Readonly<SessionPreviewHeaderMetaProps>) {
  const { t } = useTranslation();
  // Re-renders when an ack lands, so a raise the user already answered stops
  // reading as needs input (the row does the same). The hydration phase is read
  // beside the revision: the ack store answers "not acked" for every raise while
  // it loads, so the header holds its state label until that settles.
  useSessionAttentionRevision();
  const hydration = useSessionAttentionHydration();

  const raiseId = liveRow ? (liveRow.status_updated_at ?? liveRow.status ?? null) : null;
  /* Which status this header decides from. A live row is re-read every poll and
     wins outright, including when it reports no status: a finished row has no
     raise, so the header must not fall back to the status the target was opened
     with. A preview that outlives its row carries the row's own status and
     status time, and re-derives from those: the flag it was opened with may be
     the `false` a held store reported, which would otherwise keep the state
     label hidden after the store hydrated. A target that carries no status has
     nothing to re-derive from and keeps its flag. */
  const previewStatus = liveRow ? liveRow.status : target.status;
  // The same raise identity the row uses: its own status time when it has one,
  // so an ack naming that exact raise is honoured here too.
  const previewRaiseId = liveRow ? raiseId : (target.statusUpdatedAt ?? target.status ?? null);
  const needsInput =
    previewStatus === undefined
      ? target.needsInput
      : shouldShowNeedsInput({
          status: previewStatus,
          hydration,
          isAcked: isAttentionAcked(target.sessionId, {
            raiseId: previewRaiseId,
            status: previewStatus,
          }),
        });
  const liveStatus = liveRow?.status ?? null;
  const rowStatusKind: GlanceableStatusKind | null =
    liveStatus === null ? null : glanceableStatusKind(liveStatus);
  const statusKind = rowStatusKind ?? target.statusKind;

  // A finished session has no live state, so its card shows the cost alone,
  // exactly like the row it was opened from. Needs input outranks liveness.
  let stateLabel: string | null = null;
  if (needsInput) {
    stateLabel = t('agents.sessionRow.needsInput');
  } else if (target.live) {
    stateLabel = t(statusKind === 'idle' ? 'common.idle' : 'common.working');
  }
  const cost = formatSessionTotalCost(
    liveRow?.total_cost_microdollars ?? target.totalCostMicrodollars
  );

  return (
    <View className="min-w-0 flex-1">
      <Text numberOfLines={1} className="text-sm font-medium text-foreground">
        {target.title}
      </Text>
      {stateLabel || cost ? (
        <Text variant="mono" numberOfLines={1} className="mt-0.5 text-xs text-ink2">
          {stateLabel && cost ? `${stateLabel} · ${cost}` : (stateLabel ?? cost)}
        </Text>
      ) : null}
    </View>
  );
}
