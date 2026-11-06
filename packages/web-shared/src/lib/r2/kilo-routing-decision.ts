import type {
  EnkryptGuardrailReport,
  EnkryptOutputGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type {
  KiloRoutingDecisionRecord,
  ProviderRoutingDecision,
} from '@kilocode/web-shared/lib/ai-gateway/providers/routing-decision';
import {
  aiProviderMetadataKey,
  getAiProviderMetadataBucket,
  scheduleAiProviderMetadataArchive,
} from '@kilocode/web-shared/lib/r2/ai-provider-metadata-bucket';
import { createVercelProviderMetadataCollector } from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const LOG_SOURCE = 'kilo-routing-decision';

export type AiProviderMetadataCapture = {
  captureRoutingDecision: (decision: ProviderRoutingDecision) => void;
  captureVercelMetadata: (value: unknown) => void;
  /** Called at upload time, after the response. */
  captureEnkryptReport: (report: () => Promise<EnkryptGuardrailReport | null>) => void;
  /** Called at upload time, after the response. */
  captureEnkryptOutputReport: (report: () => Promise<EnkryptOutputGuardrailReport>) => void;
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
  let enkryptReport: (() => Promise<EnkryptGuardrailReport | null>) | undefined;
  let enkryptOutputReport: (() => Promise<EnkryptOutputGuardrailReport>) | undefined;
  const readReport = async <T>(name: string, report: (() => Promise<T>) | undefined) =>
    report?.().catch((error: unknown) => {
      errorExceptInTest(`[${LOG_SOURCE}] ${name} failed; archived without it`, {
        usageId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    });

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
        key: aiProviderMetadataKey(usageId),
        body: async () => {
          if (parsing) await Promise.race([parsing, vercel.completed]);
          const metadata = vercel.snapshot();
          const [enkrypt, enkryptOutput] = await Promise.all([
            readReport('Enkrypt report', enkryptReport),
            readReport('Enkrypt output report', enkryptOutputReport),
          ]);
          return JSON.stringify({
            ...record,
            ...(metadata ? { vercel: { metadata } } : {}),
            ...(enkrypt ? { enkrypt } : {}),
            ...(enkryptOutput ? { enkrypt_output: enkryptOutput } : {}),
          });
        },
      });
    },
    captureVercelMetadata(value) {
      vercel.capture(value, record?.api_kind);
    },
    captureEnkryptReport(report) {
      enkryptReport = report;
    },
    captureEnkryptOutputReport(report) {
      enkryptOutputReport = report;
    },
    waitFor(promise) {
      parsing = promise.then(
        () => {},
        () => {}
      );
    },
  };
}
