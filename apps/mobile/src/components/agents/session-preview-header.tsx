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
  // reading as needs input (the row does the same).
  useSessionAttentionRevision();

  const raiseId = liveRow ? (liveRow.status_updated_at ?? liveRow.status ?? null) : null;
  const needsInput = liveRow
    ? shouldShowNeedsInput({
        status: liveRow.status,
        raiseId,
        isAcked: isAttentionAcked(target.sessionId, raiseId),
      })
    : target.needsInput;
  const liveStatus = liveRow?.status ?? null;
  const rowStatusKind: GlanceableStatusKind | null =
    liveStatus === null ? null : glanceableStatusKind(liveStatus);
  const statusKind = rowStatusKind ?? target.statusKind;

  const stateLabel = needsInput
    ? t('agents.sessionRow.needsInput')
    : target.live
      ? t(statusKind === 'idle' ? 'common.idle' : 'common.working')
      : null;
  const cost = formatSessionTotalCost(
    liveRow?.total_cost_microdollars ?? target.totalCostMicrodollars
  );

  return (
    <View className="min-w-0 flex-1">
      <Text numberOfLines={1} className="text-sm font-medium tracking-tight text-foreground">
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
