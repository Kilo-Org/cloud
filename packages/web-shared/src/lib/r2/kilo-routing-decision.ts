import type {
  KiloRoutingDecisionRecord,
  ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  getAiProviderMetadataBucket,
  scheduleAiProviderMetadataArchive,
} from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';
import { createVercelProviderMetadataCollector } from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';

const LOG_SOURCE = 'kilo-routing-decision';

export type AiProviderMetadataCapture = {
  captureRoutingDecision: (decision: ProviderRoutingDecision) => void;
  captureVercelMetadata: (value: unknown) => void;
  waitFor: (promise: Promise<unknown>) => void;
};

export function createAiProviderMetadataCapture(
  usageId: string
): AiProviderMetadataCapture | undefined {
  const target = getAiProviderMetadataBucket(LOG_SOURCE);
  if (!target) return undefined;

  const vercel = createVercelProviderMetadataCollector();
  let record: KiloRoutingDecisionRecord | undefined;
  let parsing: Promise<void> | undefined;

  return {
    captureRoutingDecision(decision) {
      if (record) return;
      record = {
        schema_version: 1,
        usage_id: usageId,
        created_at: new Date().toISOString(),
        ...decision,
      };
      scheduleAiProviderMetadataArchive({
        target,
        logSource: LOG_SOURCE,
        logContext: { usageId },
        key: `${usageId}.json`,
        body: async () => {
          if (parsing) await Promise.race([parsing, vercel.completed]);
          const metadata = vercel.snapshot();
          return JSON.stringify({ ...record, ...(metadata ? { vercel: { metadata } } : {}) });
        },
      });
    },
    captureVercelMetadata(value) {
      vercel.capture(value, record?.api_kind);
    },
    waitFor(promise) {
      parsing = promise.then(
        () => {},
        () => {}
      );
    },
  };
}
