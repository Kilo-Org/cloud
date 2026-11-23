import type {
  EnkryptGuardrailReport,
  EnkryptOutputGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type {
  ByokFailoverAttempt,
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
  /**
   * Keeps the first decision for the usage id and schedules the archive.
   * A repeat call is ignored. Run this before `captureVercelMetadata` so the
   * archive carries the request's api_kind.
   */
  captureRoutingDecision: (decision: ProviderRoutingDecision) => void;
  /**
   * Called per response chunk, including the terminal one. The api_kind comes
   * from the recorded decision. A call before `captureRoutingDecision` loses
   * it silently and leaves the collector to infer the protocol from the chunk.
   */
  captureVercelMetadata: (value: unknown) => void;
  /**
   * Stores the report reader. It is invoked at upload time, after the response.
   */
  captureEnkryptReport: (report: () => Promise<EnkryptGuardrailReport | null>) => void;
  /**
   * Stores the output report reader. It is invoked at upload time, after the
   * response.
   */
  captureEnkryptOutputReport: (report: () => Promise<EnkryptOutputGuardrailReport>) => void;
  /**
   * Stores the attempts promise. It is awaited at upload time, after the
   * response.
   */
  captureByokFailoverAttempts: (attempts: Promise<readonly ByokFailoverAttempt[]>) => void;
  /**
   * Registers the promise that the archive body races against
   * `vercel.completed`. Call it before the archive body runs. It holds one
   * promise only, so a later call replaces the earlier one. It swallows the
   * rejection on purpose, so a failed parse is archived without its partial
   * data instead of failing the upload.
   */
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
  let byokFailoverAttempts: (() => Promise<readonly ByokFailoverAttempt[]>) | undefined;
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
          const [enkrypt, enkryptOutput, failoverAttempts] = await Promise.all([
            readReport('Enkrypt report', enkryptReport),
            readReport('Enkrypt output report', enkryptOutputReport),
            readReport('BYOK failover attempts', byokFailoverAttempts),
          ]);
          return JSON.stringify({
            ...record,
            ...(metadata ? { vercel: { metadata } } : {}),
            ...(enkrypt ? { enkrypt } : {}),
            ...(enkryptOutput ? { enkrypt_output: enkryptOutput } : {}),
            ...(failoverAttempts?.length ? { byok_failover_attempts: failoverAttempts } : {}),
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
    captureByokFailoverAttempts(attempts) {
      byokFailoverAttempts = () => attempts;
    },
    waitFor(promise) {
      parsing = promise.then(
        () => {},
        () => {}
      );
    },
  };
}
