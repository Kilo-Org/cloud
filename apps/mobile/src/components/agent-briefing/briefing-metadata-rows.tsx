import { type BriefingSourceMetadata } from '@kilocode/app-shared/agent-briefing';
import { type TFunction } from 'i18next';

import { Text } from '@/components/ui/text';
import { formatNumber } from '@/lib/format';

/** The failure wording of each payload kind. */
const FAILURE_KIND_KEYS = {
  provider: 'agentBriefing.metadataFailureProvider',
  tool: 'agentBriefing.metadataFailureTool',
  cancelled: 'agentBriefing.metadataFailureCancelled',
  other: 'agentBriefing.metadataFailureOther',
} as const;

/**
 * The metadata rows as reader-language lines, in display order. Absent members
 * add no line; a zero count still renders its own line.
 */
export function briefingMetadataTexts(
  metadata: BriefingSourceMetadata,
  t: TFunction,
  language: string
): string[] {
  const texts: string[] = [];
  const { plan, changes, failure } = metadata;
  if (plan) {
    texts.push(
      t('agentBriefing.metadataPlan', {
        count: plan.total,
        displayDone: formatNumber(plan.done, language),
        displayTotal: formatNumber(plan.total, language),
      })
    );
    if (plan.current) {
      texts.push(t('agentBriefing.metadataPlanCurrent', { current: plan.current }));
    }
  }
  if (changes) {
    texts.push(
      t('agentBriefing.metadataFiles', {
        count: changes.files,
        displayCount: formatNumber(changes.files, language),
      }),
      t('agentBriefing.metadataLinesAdded', {
        count: changes.added,
        displayCount: formatNumber(changes.added, language),
      }),
      t('agentBriefing.metadataLinesRemoved', {
        count: changes.removed,
        displayCount: formatNumber(changes.removed, language),
      })
    );
  }
  if (failure) {
    texts.push(t('agentBriefing.metadataFailure', { kind: t(FAILURE_KIND_KEYS[failure.kind]) }));
  }
  return texts;
}

/** One selectable, wrapping text per present metadata member. */
export function BriefingMetadataRows({
  metadata,
  t,
  language,
}: {
  readonly metadata: BriefingSourceMetadata;
  readonly t: TFunction;
  readonly language: string;
}) {
  return (
    <>
      {briefingMetadataTexts(metadata, t, language).map(text => (
        <Text key={text} className="text-sm text-muted-foreground" selectable>
          {text}
        </Text>
      ))}
    </>
  );
}
