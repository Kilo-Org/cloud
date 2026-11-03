import type {
  KiloRoutingDecisionRecord,
  ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  getAiProviderMetadataBucket,
  scheduleAiProviderMetadataArchive,
} from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';

const LOG_SOURCE = 'kilo-routing-decision';

/** Archives the gateway's provider routing decision as `kilo/<usage id>.json` after the response. */
export function archiveKiloRoutingDecision(
  usageId: string,
  decision: ProviderRoutingDecision
): void {
  const target = getAiProviderMetadataBucket(LOG_SOURCE);
  if (!target) return;
  const createdAt = new Date().toISOString();
  scheduleAiProviderMetadataArchive({
    target,
    logSource: LOG_SOURCE,
    logContext: { usageId },
    key: `kilo/${usageId}.json`,
    body: () =>
      JSON.stringify({
        schema_version: 1,
        usage_id: usageId,
        created_at: createdAt,
        ...decision,
      } satisfies KiloRoutingDecisionRecord),
  });
}
